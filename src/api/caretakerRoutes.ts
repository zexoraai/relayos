import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { validateBody } from './validate';
import { caretakerRulesBodySchema } from '../schemas/settings';
import { getDb } from '../db/connection';
import { resolveReview } from '../caretaker';
import { processPipelineJob } from '../pipeline';
import { dispatchByPurpose } from '../whatsapp';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'caretaker-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /caretaker/rules
 */
router.get('/rules', requirePermission('caretaker.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  let row = await db('caretaker_rules').where({ tenant_id: tenantId }).first();
  if (!row) {
    return res.status(200).json({
      success: true,
      data: { configured: false, defaults_will_be_used: true },
    });
  }
  return res.status(200).json({ success: true, data: row });
});

/**
 * POST /caretaker/rules - upsert per-tenant rule config.
 */
router.post('/rules', requirePermission('caretaker.rules.manage'), validateBody(caretakerRulesBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const data: any = { tenant_id: tenantId, ...req.body };

  const existing = await db('caretaker_rules').where({ tenant_id: tenantId }).first();
  if (existing) {
    await db('caretaker_rules').where({ id: existing.id }).update({ ...data, updated_at: new Date() });
  } else {
    await db('caretaker_rules').insert(data);
  }

  log.info({ tenantId }, 'Caretaker rules updated');
  return res.status(200).json({ success: true, data: { message: 'Caretaker rules saved' } });
});

/**
 * GET /caretaker/evaluations - list pending reviews + recent decisions.
 *
 * Each row is enriched with `age_seconds` (how long the evaluation has been
 * sitting unresolved, or how long ago it was resolved) and `urgency`
 * (critical / high / normal / fresh / resolved) so the operator can spot
 * orders nearing a missed-collection window without doing arithmetic.
 *
 * Urgency thresholds, applied to UNRESOLVED rows only:
 *   - critical : > 24h    (collection window slipping)
 *   - high     : 8 - 24h
 *   - normal   : 2 - 8h
 *   - fresh    : < 2h
 *
 * Resolved rows always carry urgency='resolved' regardless of age.
 *
 * Query params:
 *   - verdict   : 'approve' | 'review' | 'reject' filter
 *   - urgency   : single tier; the API also returns `counts` per tier so
 *                 the UI can render filter chips with live numbers
 *                 without a second roundtrip
 *   - sort      : 'urgency' (default — oldest unresolved first), 'newest',
 *                 'oldest'
 *   - limit     : 1..200 (default 50)
 */
router.get('/evaluations', requirePermission('caretaker.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { verdict, urgency: urgencyFilter, sort } = req.query;
  const limitNum = Math.max(1, Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200));

  let q = db('caretaker_evaluations as ce')
    .leftJoin('pipeline_jobs as pj', 'pj.id', 'ce.pipeline_job_id')
    .leftJoin('orders as o', 'o.pipeline_job_id', 'pj.id')
    // Latest reconciliation row per pipeline_job (if any). Done as a
    // correlated lateral join so a job with multiple reconciliations
    // (e.g. across reprocesses) returns only the most recent.
    .joinRaw(`
      LEFT JOIN LATERAL (
        SELECT decision, confidence, ai_used, ai_suggestion, missing_after
          FROM ai_address_reconciliations
         WHERE pipeline_job_id = ce.pipeline_job_id
         ORDER BY created_at DESC
         LIMIT 1
      ) recon ON TRUE
    `)
    .where('ce.tenant_id', tenantId)
    .select(
      'ce.id', 'ce.verdict', 'ce.mode', 'ce.flags', 'ce.checks',
      'ce.summary', 'ce.resolution', 'ce.resolved_by', 'ce.resolved_at', 'ce.created_at',
      'ce.pipeline_job_id',
      'pj.status as pipeline_status',
      'pj.current_stage',
      'pj.email_id',
      'pj.caretaker_verdict as pipeline_caretaker_verdict',
      'pj.last_error as pipeline_last_error',
      'o.order_number as order_number',
      'o.customer_name as customer_name',
      'o.waybill as order_waybill',
      'o.status as order_status',
      'recon.decision as recon_decision',
      'recon.confidence as recon_confidence',
      'recon.ai_used as recon_ai_used',
      'recon.ai_suggestion as recon_ai_suggestion',
      'recon.missing_after as recon_missing_after',
    );

  if (verdict) q = q.where('ce.verdict', verdict as string);

  // Pull a generous super-set then enrich and apply urgency filter / sort
  // in JS. We keep the over-fetch small (3x) so DB cost stays bounded
  // while letting urgency sort produce stable results across the full
  // tenant queue, not just the most-recent slice.
  const overFetchLimit = Math.min(limitNum * 3, 600);
  const rawRows = await q.orderBy('ce.created_at', 'desc').limit(overFetchLimit);

  const HOUR = 3600;
  const tierFor = (ageSec: number, resolved: boolean): 'critical' | 'high' | 'normal' | 'fresh' | 'resolved' => {
    if (resolved) return 'resolved';
    if (ageSec >= 24 * HOUR) return 'critical';
    if (ageSec >= 8 * HOUR) return 'high';
    if (ageSec >= 2 * HOUR) return 'normal';
    return 'fresh';
  };
  const tierRank: Record<string, number> = { critical: 0, high: 1, normal: 2, fresh: 3, resolved: 4 };

  const now = Date.now();
  const enriched = rawRows.map((r: any) => {
    const resolved = !!r.resolution;
    const refTime = resolved && r.resolved_at ? new Date(r.resolved_at).getTime() : new Date(r.created_at).getTime();
    const ageSec = Math.max(0, Math.floor((now - refTime) / 1000));
    return { ...r, age_seconds: ageSec, urgency: tierFor(ageSec, resolved) };
  });

  // Tier counts BEFORE urgency filter so chips show the full picture.
  const counts = { critical: 0, high: 0, normal: 0, fresh: 0, resolved: 0, all: enriched.length };
  for (const r of enriched) (counts as any)[r.urgency] += 1;

  let filtered = enriched;
  if (typeof urgencyFilter === 'string' && urgencyFilter && urgencyFilter !== 'all') {
    filtered = enriched.filter((r) => r.urgency === urgencyFilter);
  }

  const sortMode = (sort as string) || 'urgency';
  if (sortMode === 'urgency') {
    // Default: most-painful-first. Oldest within each tier. Resolved rows
    // sink to the bottom regardless of age.
    filtered.sort((a, b) => {
      const ta = tierRank[a.urgency] ?? 9;
      const tb = tierRank[b.urgency] ?? 9;
      if (ta !== tb) return ta - tb;
      return b.age_seconds - a.age_seconds; // older first within tier
    });
  } else if (sortMode === 'oldest') {
    filtered.sort((a, b) => b.age_seconds - a.age_seconds);
  } else {
    // 'newest'
    filtered.sort((a, b) => a.age_seconds - b.age_seconds);
  }

  const rows = filtered.slice(0, limitNum);
  return res.status(200).json({ success: true, data: rows, counts });
});

/**
 * GET /caretaker/evaluations/:id
 *
 * Returns the evaluation, the current snapshot of pipeline-extracted data
 * (so the dashboard can pre-fill the edit form), and any prior reviewer
 * overrides. Used by the override-and-approve UI.
 */
router.get('/evaluations/:id', requirePermission('caretaker.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  // Pull the customer_data + locker stage outputs for this pipeline job so
  // the UI can show what the AI extracted (and what the reviewer is overriding).
  const stages = await db('pipeline_stage_results')
    .where({ pipeline_job_id: ev.pipeline_job_id })
    .orderBy('created_at', 'asc')
    .select('stage', 'status', 'output_data', 'created_at');

  const findStage = (name: string) => stages.find((s: any) => s.stage === name);
  const parse = (v: any) => {
    if (!v) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return null; }
  };

  const customerData = parse(findStage('CUSTOMER_DATA')?.output_data);
  const lockersResolved = parse(findStage('LOCKERS_RESOLVED')?.output_data);
  const dataExtracted = parse(findStage('DATA_EXTRACTED')?.output_data);
  // The new reconciliation stage carries the entered/geocoded/AI triplet
  // and the decision so the modal can show the operator exactly what was
  // dropped, what the AI suggested, and what we ended up with.
  const locationResolved = parse(findStage('LOCATION_RESOLVED')?.output_data);
  const locationReconciled = parse(findStage('LOCATION_RECONCILED')?.output_data);
  const payloadCreated = parse(findStage('PAYLOAD_CREATED')?.output_data);

  // Reviewer context: what's the underlying pipeline job actually doing,
  // is the order already in a queue, and what other evaluations exist on
  // this same job so the reviewer can spot patterns ("this is the third
  // time we've reviewed this order"). All optional — the modal still works
  // without these.
  const pipelineJob = await db('pipeline_jobs')
    .where({ id: ev.pipeline_job_id, tenant_id: tenantId })
    .first('id', 'status', 'current_stage', 'last_error', 'caretaker_verdict', 'created_at', 'updated_at');

  const order = await db('orders')
    .where({ pipeline_job_id: ev.pipeline_job_id, tenant_id: tenantId })
    .first(
      'id', 'order_number', 'customer_name', 'status', 'waybill', 'pincode',
      'routing_status', 'manual_upload_reason', 'manual_uploaded_at',
      'created_at', 'updated_at',
    );

  // History: every other evaluation against the same pipeline_job_id, oldest first.
  const history = await db('caretaker_evaluations')
    .where({ pipeline_job_id: ev.pipeline_job_id, tenant_id: tenantId })
    .whereNot({ id })
    .orderBy('created_at', 'asc')
    .select(
      'id', 'verdict', 'mode', 'resolution', 'resolved_by', 'resolved_at',
      'reviewer_notes', 'summary', 'created_at',
    );

  return res.status(200).json({
    success: true,
    data: {
      evaluation: ev,
      snapshot: {
        customer_data: customerData,
        lockers_resolved: lockersResolved,
        data_extracted: dataExtracted,
        location_resolved: locationResolved,
        location_reconciled: locationReconciled,
        payload_created: payloadCreated,
      },
      pipeline_job: pipelineJob || null,
      order: order || null,
      history,
    },
  });
});

/**
 * POST /caretaker/evaluations/:id/resolve
 * Body:
 *   { resolution: 'approved' | 'rejected',
 *     overrides?: { customer_name?, customer_phone?, delivery_method?, delivery_address?, line_items?, locker? },
 *     notes?: string }
 *
 * On approve, the pipeline is re-enqueued; the next pass merges `overrides`
 * over the AI-extracted data via executeCustomerData.
 */
router.post('/evaluations/:id/resolve', requirePermission('caretaker.review.approve', 'caretaker.review.reject'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const userEmail = req.tenant!.email || 'unknown';
  const { id } = req.params as { id: string };
  const { resolution, overrides, notes, notify_customer } = req.body || {};

  if (!['approved', 'rejected'].includes(resolution)) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_RESOLUTION', message: 'resolution must be approved or rejected' },
    });
  }
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_OVERRIDES', message: 'overrides must be a JSON object' },
    });
  }

  const db = getDb();
  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  const result = await resolveReview({
    evaluationId: id,
    resolution,
    resolvedBy: userEmail,
    reviewerOverrides: overrides ?? null,
    reviewerNotes: typeof notes === 'string' ? notes : null,
  });

  // If approved, resume pipeline. If rejected, just mark the job rejected.
  if (resolution === 'approved') {
    const job = await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).first();
    if (job) {
      // Re-run from the beginning; the courier-submitted stage is idempotent on order_number,
      // and the caretaker short-circuits because the prior evaluation was approved.
      await db('pipeline_jobs').where({ id: job.id }).update({
        status: 'processing',
        updated_at: new Date(),
      });
      processPipelineJob({
        emailId: job.email_id,
        tenantId: job.tenant_id,
        mailboxId: job.mailbox_id,
        correlationId: job.correlation_id,
      }).catch((err) => log.error({ jobId: job.id, err: err.message }, 'Resume pipeline failed'));
    }

    // Optional courtesy: notify the customer via WhatsApp template when the
    // reviewer changed their address or phone, so the customer can confirm
    // before the parcel ships. Default OFF — opt in per approve via the
    // notify_customer flag in the request body. Address-change notifications
    // are the most common use case (locker swap / suburb correction).
    if (notify_customer && overrides && typeof overrides === 'object') {
      const ov = overrides as Record<string, unknown>;
      const changeBits: string[] = [];
      if (ov.delivery_address && typeof ov.delivery_address === 'object') {
        changeBits.push('updated delivery address');
      }
      if (typeof ov.customer_phone === 'string' && ov.customer_phone.trim()) {
        changeBits.push('updated contact number');
      }
      if (typeof ov.delivery_method === 'string' && ov.delivery_method.trim()) {
        changeBits.push(`switched to ${ov.delivery_method.replace(/-/g, ' ')}`);
      }

      if (changeBits.length) {
        // Resolve the order so we know who to message and what order_number to cite.
        // Caretaker may run before COURIER_SUBMITTED has created the order, so this
        // is best-effort: if there's no order yet, we skip silently.
        const order = await db('orders').where({ pipeline_job_id: ev.pipeline_job_id, tenant_id: tenantId }).first();
        if (order && (order.customer_phone || (typeof ov.customer_phone === 'string' && ov.customer_phone))) {
          const targetPhone = (typeof ov.customer_phone === 'string' && ov.customer_phone.trim()) || order.customer_phone;
          const summary = changeBits.join(', ');
          // Capitalize the first character so the rendered message reads cleanly.
          const change_summary = summary.charAt(0).toUpperCase() + summary.slice(1) + '.';

          dispatchByPurpose({
            tenantId,
            purpose: 'order_details_updated',
            toPhone: targetPhone,
            variables: {
              customer_name: order.customer_name || 'there',
              order_number: order.order_number || '',
              change_summary,
            },
            orderId: order.id,
          }).catch((err: any) => log.warn({ orderId: order.id, err: err.message }, 'order_details_updated WhatsApp send failed'));

          log.info({ orderId: order.id, changes: changeBits }, 'Reviewer override — customer notified via WhatsApp');
        }
      }
    }
  } else {
    await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).update({
      status: 'rejected',
      last_error: 'Rejected by reviewer',
      updated_at: new Date(),
    });
  }

  return res.status(200).json({ success: true, data: result });
});

/**
 * POST /caretaker/evaluations/:id/reopen
 *
 * Convert a previously-resolved evaluation (typically rejected) back into
 * a pending review so the operator can edit + approve it. Useful when the
 * LLM auto-rejected something the human disagrees with.
 *
 * Sets the evaluation's verdict back to 'review' and clears resolution.
 * Flips the pipeline_job back to pending_review.
 */
router.post('/evaluations/:id/reopen', requirePermission('caretaker.review.approve'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const userEmail = req.tenant!.email || 'unknown';
  const { id } = req.params as { id: string };

  const db = getDb();
  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  await db('caretaker_evaluations').where({ id }).update({
    verdict: 'review',
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    summary: ev.summary ? `${ev.summary} (reopened by ${userEmail})` : `Reopened by ${userEmail}`,
  });

  await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).update({
    status: 'pending_review',
    caretaker_verdict: 'review',
    last_error: null,
    updated_at: new Date(),
  });

  log.info({ evaluationId: id, pipelineJobId: ev.pipeline_job_id, by: userEmail }, 'Evaluation reopened for review');
  return res.status(200).json({ success: true, data: { id, verdict: 'review' } });
});

export default router;
