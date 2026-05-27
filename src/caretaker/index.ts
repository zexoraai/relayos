import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { CustomerData } from '../pipeline/stages/customerData';
import { LockersResolvedResult } from '../pipeline/stages/lockersResolved';
import { PudoPayload } from '../pipeline/stages/payloadCreated';
import { llmEvaluate, mergeVerdicts } from './llmEvaluator';

const log = createChildLogger({ module: 'caretaker' });

function parseJsonArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Verdicts returned by the caretaker.
 *  - approve: send to courier as planned
 *  - review:  pause the pipeline; human approves/rejects from dashboard
 *  - reject:  halt and emit order.flagged (no courier submission, no order created)
 */
export type CaretakerVerdict = 'approve' | 'review' | 'reject';

export type CaretakerMode = 'shadow' | 'advisory' | 'strict';

export interface CaretakerCheck {
  check: string;
  passed: boolean;
  message?: string;
  severity: 'info' | 'warn' | 'error';
}

export interface CaretakerEvaluation {
  id: string | null;       // populated after persistence
  verdict: CaretakerVerdict;
  mode: CaretakerMode;
  flags: string[];
  checks: CaretakerCheck[];
  summary: string;
}

export interface CaretakerInput {
  tenantId: string;
  pipelineJobId: string;
  customerData: CustomerData;
  locker: LockersResolvedResult;
  payload: PudoPayload;
}

interface CaretakerRulesRow {
  id: string;
  tenant_id: string;
  enabled: boolean;
  max_rate_per_order: string | null;     // numeric -> string
  max_distance_km: number | null;
  require_phone: boolean;
  require_customer_name: boolean;
  require_line_items: boolean;
  block_duplicate_order_number: boolean;
  block_repeat_phone_within_minutes: boolean;
  repeat_phone_window_minutes: number;
  mode: CaretakerMode;
  llm_enabled: boolean;
}

const DEFAULT_RULES: Omit<CaretakerRulesRow, 'id' | 'tenant_id'> = {
  enabled: true,
  max_rate_per_order: null,
  max_distance_km: 25,
  require_phone: true,
  require_customer_name: true,
  require_line_items: true,
  block_duplicate_order_number: true,
  block_repeat_phone_within_minutes: false,
  repeat_phone_window_minutes: 30,
  mode: 'advisory',
  llm_enabled: false,
};

/**
 * Lazy-load (and seed if missing) the per-tenant caretaker rule row.
 * Defaults are written to DB the first time a tenant runs through caretaker.
 */
async function loadRules(tenantId: string): Promise<CaretakerRulesRow> {
  const db = getDb();
  let row = await db('caretaker_rules').where({ tenant_id: tenantId }).first();
  if (!row) {
    const [inserted] = await db('caretaker_rules')
      .insert({ tenant_id: tenantId, ...DEFAULT_RULES })
      .returning('*');
    row = inserted;
    log.info({ tenantId }, 'Default caretaker rules seeded');
  }
  return row;
}

function checkPhone(rules: CaretakerRulesRow, data: CustomerData): CaretakerCheck {
  if (!rules.require_phone) {
    return { check: 'phone_present', passed: true, severity: 'info' };
  }
  const phone = (data.customerPhone || '').trim();
  return {
    check: 'phone_present',
    passed: phone.length >= 8,
    message: phone.length >= 8 ? undefined : 'Customer phone is missing or too short',
    severity: 'error',
  };
}

function checkName(rules: CaretakerRulesRow, data: CustomerData): CaretakerCheck {
  if (!rules.require_customer_name) {
    return { check: 'name_present', passed: true, severity: 'info' };
  }
  const name = (data.customerName || '').trim();
  return {
    check: 'name_present',
    passed: name.length >= 2,
    message: name.length >= 2 ? undefined : 'Customer name is missing',
    severity: 'error',
  };
}

function checkLineItems(rules: CaretakerRulesRow, data: CustomerData): CaretakerCheck {
  if (!rules.require_line_items) {
    return { check: 'line_items_present', passed: true, severity: 'info' };
  }
  const items = data.line_items || [];
  return {
    check: 'line_items_present',
    passed: items.length > 0,
    message: items.length > 0 ? undefined : 'Order has no line items',
    severity: 'error',
  };
}

function checkDistance(rules: CaretakerRulesRow, locker: LockersResolvedResult): CaretakerCheck {
  if (rules.max_distance_km === null || rules.max_distance_km === undefined) {
    return { check: 'distance_within_cap', passed: true, severity: 'info' };
  }
  const dist = parseFloat(locker?.distance_km || '0');
  const capped = !isNaN(dist) && dist > rules.max_distance_km;
  return {
    check: 'distance_within_cap',
    passed: !capped,
    message: capped ? `Locker distance ${dist.toFixed(2)}km exceeds cap ${rules.max_distance_km}km` : undefined,
    severity: 'warn',
  };
}

async function checkDuplicateOrder(
  rules: CaretakerRulesRow,
  tenantId: string,
  data: CustomerData,
): Promise<CaretakerCheck> {
  if (!rules.block_duplicate_order_number) {
    return { check: 'order_number_unique', passed: true, severity: 'info' };
  }
  const orderNumber = (data.OrderNumber || '').trim();
  if (!orderNumber) {
    return { check: 'order_number_unique', passed: true, severity: 'info' };
  }
  const db = getDb();
  const existing = await db('orders')
    .where({ tenant_id: tenantId, order_number: orderNumber })
    .first();
  return {
    check: 'order_number_unique',
    passed: !existing,
    message: existing ? `Order #${orderNumber} already exists for this tenant` : undefined,
    severity: 'error',
  };
}

async function checkRepeatPhone(
  rules: CaretakerRulesRow,
  tenantId: string,
  data: CustomerData,
): Promise<CaretakerCheck> {
  if (!rules.block_repeat_phone_within_minutes) {
    return { check: 'repeat_phone_window', passed: true, severity: 'info' };
  }
  const phone = (data.customerPhone || '').trim();
  if (!phone) {
    return { check: 'repeat_phone_window', passed: true, severity: 'info' };
  }
  const db = getDb();
  const cutoff = new Date(Date.now() - rules.repeat_phone_window_minutes * 60 * 1000);
  const recent = await db('orders')
    .where({ tenant_id: tenantId, customer_phone: phone })
    .where('created_at', '>=', cutoff)
    .first();
  return {
    check: 'repeat_phone_window',
    passed: !recent,
    message: recent ? `Another order from ${phone} within last ${rules.repeat_phone_window_minutes}min` : undefined,
    severity: 'warn',
  };
}

function checkRate(rules: CaretakerRulesRow, payload: PudoPayload): CaretakerCheck {
  // Rate is on the response side, not payload. Skip if no cap.
  if (!rules.max_rate_per_order) {
    return { check: 'rate_under_cap', passed: true, severity: 'info' };
  }
  // Rate isn't known until courier responds; this check is a placeholder for future.
  return { check: 'rate_under_cap', passed: true, severity: 'info' };
}

/**
 * Decide the verdict from the failed checks and the mode.
 *
 *   shadow:    always approve (just record)
 *   advisory:  fail any check -> review
 *   strict:    fail any error-level check -> reject; warn-level -> review
 */
function decide(checks: CaretakerCheck[], mode: CaretakerMode): { verdict: CaretakerVerdict; flags: string[]; summary: string } {
  const failed = checks.filter((c) => !c.passed);
  const flags = failed.map((c) => c.check);

  if (failed.length === 0) {
    return { verdict: 'approve', flags: [], summary: 'All checks passed' };
  }

  const summary = failed.map((c) => c.message || c.check).join('; ');

  if (mode === 'shadow') {
    return { verdict: 'approve', flags, summary };
  }

  const hasError = failed.some((c) => c.severity === 'error');

  if (mode === 'strict' && hasError) {
    return { verdict: 'reject', flags, summary };
  }

  return { verdict: 'review', flags, summary };
}

/**
 * Run the caretaker for a single pipeline job.
 * Persists a caretaker_evaluations row and updates pipeline_jobs.caretaker_verdict.
 */
export async function evaluate(input: CaretakerInput): Promise<CaretakerEvaluation> {
  const db = getDb();
  const rules = await loadRules(input.tenantId);

  // Short-circuit on resume: if a previous evaluation for this pipeline_job
  // was already resolved as approved by a human, trust that decision and
  // pass through. The new evaluation is recorded so the audit trail stays
  // intact, but it inherits the verdict.
  const priorApproved = await db('caretaker_evaluations')
    .where({ pipeline_job_id: input.pipelineJobId, resolution: 'approved' })
    .orderBy('resolved_at', 'desc')
    .first();
  if (priorApproved) {
    const flags = parseJsonArray(priorApproved.flags);
    const summary = `Auto-approved on resume — previously approved by ${priorApproved.resolved_by || 'reviewer'}${
      priorApproved.summary ? ' (' + priorApproved.summary + ')' : ''
    }`;
    const [row] = await db('caretaker_evaluations')
      .insert({
        tenant_id: input.tenantId,
        pipeline_job_id: input.pipelineJobId,
        verdict: 'approve',
        mode: rules.mode,
        checks: JSON.stringify([]),
        flags: JSON.stringify(flags),
        summary,
        llm_ran: false,
        llm_verdict: null,
        llm_confidence: null,
        llm_reasons: JSON.stringify([]),
        llm_flags: JSON.stringify([]),
      })
      .returning('id');

    await db('pipeline_jobs').where({ id: input.pipelineJobId }).update({
      caretaker_verdict: 'approve',
      caretaker_evaluation_id: row.id,
      updated_at: new Date(),
    });

    log.info(
      { pipelineJobId: input.pipelineJobId, priorEvalId: priorApproved.id },
      'Caretaker short-circuited (prior evaluation was approved)',
    );

    return { id: row.id, verdict: 'approve', mode: rules.mode, flags, checks: [], summary };
  }

  if (!rules.enabled) {
    const out: CaretakerEvaluation = {
      id: null,
      verdict: 'approve',
      mode: rules.mode,
      flags: [],
      checks: [],
      summary: 'Caretaker disabled - auto-approved',
    };
    return out;
  }

  const checks: CaretakerCheck[] = [
    checkPhone(rules, input.customerData),
    checkName(rules, input.customerData),
    checkLineItems(rules, input.customerData),
    checkDistance(rules, input.locker),
    checkRate(rules, input.payload),
    await checkDuplicateOrder(rules, input.tenantId, input.customerData),
    await checkRepeatPhone(rules, input.tenantId, input.customerData),
  ];

  const decision = decide(checks, rules.mode);

  // Optional LLM pass — runs only if the tenant has it enabled and OpenAI is configured.
  // The LLM can escalate (approve -> review, review -> reject) but never relax.
  let finalVerdict = decision.verdict;
  let mergedFlags = [...decision.flags];
  let mergedSummary = decision.summary;
  let llm = { ran: false, verdict: decision.verdict, confidence: 0, reasons: [] as string[], flags: [] as string[], summary: '' };

  if (rules.llm_enabled) {
    const llmRes = await llmEvaluate({
      customerData: input.customerData,
      locker: input.locker,
      payload: input.payload,
      rulesVerdict: decision.verdict,
      rulesFlags: decision.flags,
    });
    if (llmRes.ran) {
      llm = { ran: true, verdict: llmRes.verdict, confidence: llmRes.confidence, reasons: llmRes.reasons, flags: llmRes.flags, summary: llmRes.summary };

      // Mode-aware merge:
      //   shadow   : LLM never changes the verdict (record-only)
      //   advisory : LLM may escalate to 'review' but NEVER to 'reject'.
      //              Anything the LLM dislikes still ends up in the human queue.
      //   strict   : LLM may escalate all the way to 'reject' (current full power).
      let llmCappedVerdict = llmRes.verdict;
      if (rules.mode === 'advisory' && llmCappedVerdict === 'reject') {
        llmCappedVerdict = 'review';
      }
      const llmMergedVerdict = rules.mode === 'shadow'
        ? decision.verdict
        : mergeVerdicts(decision.verdict, llmCappedVerdict);

      finalVerdict = llmMergedVerdict;
      if (llmRes.flags.length) mergedFlags = Array.from(new Set([...mergedFlags, ...llmRes.flags]));
      if (llmRes.summary && llmMergedVerdict !== 'approve') {
        mergedSummary = mergedSummary
          ? `${mergedSummary}; LLM: ${llmRes.summary}`
          : `LLM: ${llmRes.summary}`;
      }
    } else if (llmRes.skipped_reason) {
      log.debug({ reason: llmRes.skipped_reason }, 'LLM caretaker skipped');
    }
  }

  // Persist
  //
  // We may already have an open (unresolved) evaluation for this
  // pipeline_job_id from a previous pass. Without this, every reprocess
  // / re-run created a *new* row and left the old one stuck at
  // verdict=review with no resolution, so the Caretaker tab showed two
  // identical "review" pills for the same order. Collapse that here:
  // if an unresolved row exists, UPDATE it instead of inserting; old
  // resolutions stay intact for audit history.
  const openExisting = await db('caretaker_evaluations')
    .where({ pipeline_job_id: input.pipelineJobId })
    .whereNull('resolution')
    .orderBy('created_at', 'desc')
    .first();

  let row: { id: string };
  if (openExisting) {
    await db('caretaker_evaluations').where({ id: openExisting.id }).update({
      verdict: finalVerdict,
      mode: rules.mode,
      checks: JSON.stringify(checks),
      flags: JSON.stringify(mergedFlags),
      summary: mergedSummary,
      llm_ran: llm.ran,
      llm_verdict: llm.ran ? llm.verdict : null,
      llm_confidence: llm.ran ? llm.confidence : null,
      llm_reasons: JSON.stringify(llm.reasons),
      llm_flags: JSON.stringify(llm.flags),
      updated_at: new Date(),
    });
    row = { id: openExisting.id };
    log.info(
      { pipelineJobId: input.pipelineJobId, evaluationId: openExisting.id },
      'Caretaker re-evaluated open row in place (no duplicate)',
    );
  } else {
    const inserted = await db('caretaker_evaluations')
      .insert({
        tenant_id: input.tenantId,
        pipeline_job_id: input.pipelineJobId,
        verdict: finalVerdict,
        mode: rules.mode,
        checks: JSON.stringify(checks),
        flags: JSON.stringify(mergedFlags),
        summary: mergedSummary,
        llm_ran: llm.ran,
        llm_verdict: llm.ran ? llm.verdict : null,
        llm_confidence: llm.ran ? llm.confidence : null,
        llm_reasons: JSON.stringify(llm.reasons),
        llm_flags: JSON.stringify(llm.flags),
      })
      .returning('id');
    row = inserted[0];
  }

  await db('pipeline_jobs').where({ id: input.pipelineJobId }).update({
    caretaker_verdict: finalVerdict,
    caretaker_evaluation_id: row.id,
    updated_at: new Date(),
  });

  log.info({
    pipelineJobId: input.pipelineJobId,
    verdict: finalVerdict,
    mode: rules.mode,
    llm_ran: llm.ran,
    llm_verdict: llm.ran ? llm.verdict : null,
    flags: mergedFlags,
  }, 'Caretaker evaluation completed');

  return {
    id: row.id,
    verdict: finalVerdict,
    mode: rules.mode,
    flags: mergedFlags,
    checks,
    summary: mergedSummary,
  };
}

/**
 * Manually resolve a pending review.
 * Optionally apply reviewer-supplied overrides (typed via the resolve API)
 * and reviewer notes. The override blob is shallow-merged on the next
 * pipeline pass via executeCustomerData.
 */
export async function resolveReview(args: {
  evaluationId: string;
  resolution: 'approved' | 'rejected';
  resolvedBy: string;
  reviewerOverrides?: Record<string, unknown> | null;
  reviewerNotes?: string | null;
}): Promise<{ evaluation_id: string; pipeline_job_id: string; verdict: CaretakerVerdict; resolution: 'approved' | 'rejected' } | null> {
  const db = getDb();
  const ev = await db('caretaker_evaluations').where({ id: args.evaluationId }).first();
  if (!ev) return null;

  const updates: Record<string, unknown> = {
    resolution: args.resolution,
    resolved_by: args.resolvedBy,
    resolved_at: new Date(),
  };
  if (args.reviewerOverrides !== undefined) {
    updates.reviewer_overrides = args.reviewerOverrides ? JSON.stringify(args.reviewerOverrides) : null;
  }
  if (args.reviewerNotes !== undefined) {
    updates.reviewer_notes = args.reviewerNotes;
  }
  await db('caretaker_evaluations').where({ id: args.evaluationId }).update(updates);

  // The pipeline job's verdict reflects the final decision so workers/UI can act on it.
  const newVerdict: CaretakerVerdict = args.resolution === 'approved' ? 'approve' : 'reject';
  await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).update({
    caretaker_verdict: newVerdict,
    updated_at: new Date(),
  });

  log.info({
    evaluationId: args.evaluationId,
    pipelineJobId: ev.pipeline_job_id,
    resolution: args.resolution,
    resolvedBy: args.resolvedBy,
    overrideKeys: args.reviewerOverrides ? Object.keys(args.reviewerOverrides) : [],
  }, 'Caretaker review resolved');

  return {
    evaluation_id: args.evaluationId,
    pipeline_job_id: ev.pipeline_job_id,
    verdict: newVerdict,
    resolution: args.resolution,
  };
}
