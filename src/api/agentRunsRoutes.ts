import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'agent-runs-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /agent-runs - list recent runs with optional agent filter
 */
router.get('/', requirePermission('agents.runs.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { agent, status, limit = '50' } = req.query;

  let q = db('agent_runs')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(Math.min(parseInt(limit as string), 200))
    .select('id', 'agent', 'model', 'prompt_version', 'prompt_tokens', 'completion_tokens',
      'cost_usd', 'latency_ms', 'success', 'error', 'status', 'finish_reason', 'created_at');

  if (agent) q = q.andWhere({ agent: agent as string });
  if (status) q = q.andWhere({ status: status as string });

  const rows = await q;
  return res.status(200).json({ success: true, data: rows });
});

/**
 * GET /agent-runs/:id - full replay detail (messages, response, tool calls)
 */
router.get('/:id', requirePermission('agents.runs.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  const run = await db('agent_runs').where({ id, tenant_id: tenantId }).first();
  if (!run) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Run not found' } });

  // Also load any correction for this run
  const correction = await db('agent_corrections').where({ run_id: id }).first();

  return res.status(200).json({ success: true, data: { run, correction: correction || null } });
});

/**
 * POST /agent-runs/:id/approve - mark a run as approved (output was correct)
 */
router.post('/:id/approve', requirePermission('agents.runs.replay'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  const updated = await db('agent_runs')
    .where({ id, tenant_id: tenantId })
    .update({ status: 'approved' });
  if (updated === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Run not found' } });

  return res.status(200).json({ success: true, data: { message: 'Run approved' } });
});

/**
 * POST /agent-runs/:id/correct - submit a correction for a run.
 * This creates a few-shot example that will be injected into future calls.
 */
router.post('/:id/correct', requirePermission('agents.runs.correct'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { corrected_output, correction_note } = req.body;

  if (!corrected_output || !corrected_output.trim()) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'corrected_output is required' } });
  }

  const run = await db('agent_runs').where({ id, tenant_id: tenantId }).first();
  if (!run) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Run not found' } });

  // Extract the original input (last user message) and output
  let messagesIn: any[];
  try { messagesIn = typeof run.messages_in === 'string' ? JSON.parse(run.messages_in) : run.messages_in; }
  catch { messagesIn = []; }

  const lastUserMsg = [...messagesIn].reverse().find((m: any) => m.role === 'user');
  const originalInput = lastUserMsg?.content || '';

  let responseOut: any;
  try { responseOut = typeof run.response_out === 'string' ? JSON.parse(run.response_out) : run.response_out; }
  catch { responseOut = {}; }
  const originalOutput = responseOut?.content || JSON.stringify(responseOut);

  // Upsert correction (one per run)
  const existing = await db('agent_corrections').where({ run_id: id }).first();
  if (existing) {
    await db('agent_corrections').where({ id: existing.id }).update({
      corrected_output: corrected_output.trim(),
      correction_note: correction_note?.trim() || null,
      active: true,
    });
  } else {
    await db('agent_corrections').insert({
      tenant_id: tenantId,
      run_id: id,
      agent: run.agent,
      original_input: originalInput.substring(0, 4000),
      original_output: originalOutput.substring(0, 4000),
      corrected_output: corrected_output.trim(),
      correction_note: correction_note?.trim() || null,
      active: true,
    });
  }

  // Mark the run as corrected
  await db('agent_runs').where({ id }).update({ status: 'corrected' });

  log.info({ runId: id, agent: run.agent, by: req.tenant?.email }, 'Agent run corrected — will be used as few-shot example');
  return res.status(200).json({ success: true, data: { message: 'Correction saved. Future calls will learn from this.' } });
});

/**
 * GET /agent-runs/corrections - list all active corrections for the tenant
 */
router.get('/corrections/list', requirePermission('agents.runs.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { agent } = req.query;

  let q = db('agent_corrections')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(100);
  if (agent) q = q.andWhere({ agent: agent as string });

  const rows = await q;
  return res.status(200).json({ success: true, data: rows });
});

/**
 * DELETE /agent-runs/corrections/:id - deactivate a correction
 */
router.delete('/corrections/:id', requirePermission('agents.runs.correct'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  await db('agent_corrections').where({ id, tenant_id: tenantId }).update({ active: false });
  return res.status(200).json({ success: true, data: { message: 'Correction deactivated' } });
});

export default router;
