import { Router, Response } from 'express';
import multer from 'multer';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { validateBody } from './validate';
import { ingestUrlBodySchema, ingestSitemapBodySchema, knowledgeDocBodySchema, knowledgeDocPatchSchema } from '../schemas/knowledge';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { ingestUrl, ingestSitemap, ingestFile, ingestShopifyProducts, resyncSource } from '../knowledge/ingest';

const log = createChildLogger({ module: 'knowledge-api' });
const router = Router();

router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB cap
});

// --- Sources ---

router.get('/sources', requirePermission('knowledge.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const sources = await db('tenant_knowledge_sources')
    .where({ tenant_id: tenantId })
    .orderBy('updated_at', 'desc');
  return res.status(200).json({ success: true, data: sources });
});

router.post('/sources/url', requirePermission('knowledge.sources.manage'), validateBody(ingestUrlBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { url, label, category } = req.body;
  try {
    const summary = await ingestUrl({ tenantId, sourceUrl: url, label, category });
    return res.status(200).json({ success: true, data: summary });
  } catch (err: any) {
    log.warn({ tenantId, url, error: err.message }, 'URL ingest failed');
    return res.status(500).json({ success: false, error: { code: 'INGEST_FAILED', message: err.message } });
  }
});

router.post('/sources/sitemap', requirePermission('knowledge.sources.manage'), validateBody(ingestSitemapBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { sitemap_url, label, max_pages, path_prefix } = req.body;
  try {
    const summary = await ingestSitemap({ tenantId, sitemapUrl: sitemap_url, label, maxPages: max_pages, pathPrefix: path_prefix || undefined });
    return res.status(200).json({ success: true, data: summary });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'INGEST_FAILED', message: err.message } });
  }
});

router.post('/sources/upload', requirePermission('knowledge.sources.manage'), upload.single('file'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  if (!req.file) {
    return res.status(400).json({ success: false, error: { code: 'NO_FILE', message: 'Upload a file under field name "file"' } });
  }
  try {
    const summary = await ingestFile({
      tenantId,
      fileName: req.file.originalname,
      mime: req.file.mimetype,
      buffer: req.file.buffer,
      category: (req.body as any).category || null,
    });
    return res.status(200).json({ success: true, data: summary });
  } catch (err: any) {
    log.warn({ tenantId, filename: req.file.originalname, error: err.message }, 'Upload ingest failed');
    return res.status(500).json({ success: false, error: { code: 'INGEST_FAILED', message: err.message } });
  }
});

router.post('/sources/shopify-products', requirePermission('knowledge.sources.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  try {
    const summary = await ingestShopifyProducts({ tenantId, maxProducts: req.body?.max_products });
    return res.status(200).json({ success: true, data: summary });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'SHOPIFY_INGEST_FAILED', message: err.message } });
  }
});

router.post('/sources/:id/resync', requirePermission('knowledge.sources.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  try {
    const summary = await resyncSource(tenantId, id);
    return res.status(200).json({ success: true, data: summary });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'RESYNC_FAILED', message: err.message } });
  }
});

router.delete('/sources/:id', requirePermission('knowledge.sources.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  await db('tenant_knowledge_sources').where({ id, tenant_id: tenantId }).delete();
  return res.status(200).json({ success: true, data: { message: 'Source removed' } });
});

// --- Documents (existing) ---

router.get('/', requirePermission('knowledge.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { source_id, limit = '200' } = req.query;
  let q = db('tenant_knowledge_documents')
    .where({ tenant_id: tenantId })
    .orderBy('updated_at', 'desc')
    .limit(parseInt(limit as string, 10));
  if (source_id) q = q.andWhere({ source_id });
  const docs = await q;
  return res.status(200).json({ success: true, data: docs });
});

router.post('/', requirePermission('knowledge.docs.manage'), validateBody(knowledgeDocBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { title, category, body, enabled = true } = req.body;
  // Manual docs sit under a synthetic "manual" source so the UI groups them consistently
  const source = await ensureManualSource(tenantId);
  const [row] = await db('tenant_knowledge_documents').insert({
    tenant_id: tenantId,
    source_id: source.id,
    title: title.trim(),
    category: category || null,
    body: body.trim(),
    enabled: !!enabled,
  }).returning('*');
  await db('tenant_knowledge_sources').where({ id: source.id }).update({
    document_count: db.raw('document_count + 1'),
    updated_at: new Date(),
  });
  log.info({ tenantId, id: row.id }, 'Manual knowledge document created');
  return res.status(201).json({ success: true, data: row });
});

router.put('/:id', requirePermission('knowledge.docs.manage'), validateBody(knowledgeDocPatchSchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { title, category, body, enabled } = req.body;

  const data: any = { updated_at: new Date() };
  if (title !== undefined) data.title = title.trim();
  if (category !== undefined) data.category = category || null;
  if (body !== undefined) data.body = body.trim();
  if (enabled !== undefined) data.enabled = !!enabled;

  const updated = await db('tenant_knowledge_documents')
    .where({ id, tenant_id: tenantId })
    .update(data)
    .returning('*');
  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Document not found' } });
  }
  return res.status(200).json({ success: true, data: updated[0] });
});

router.delete('/:id', requirePermission('knowledge.docs.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  await db('tenant_knowledge_documents').where({ id, tenant_id: tenantId }).delete();
  return res.status(200).json({ success: true, data: { message: 'Document removed' } });
});

// --- Conversations (chatbot inbox) ---

router.get('/__conversations', requirePermission('inbox.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const conversations = await db('chat_conversations')
    .where({ tenant_id: tenantId })
    .orderBy('last_message_at', 'desc')
    .limit(100);
  return res.status(200).json({ success: true, data: conversations });
});

router.get('/__conversations/:id/messages', requirePermission('inbox.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const conv = await db('chat_conversations').where({ id, tenant_id: tenantId }).first();
  if (!conv) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
  const messages = await db('chat_messages')
    .where({ conversation_id: id })
    .orderBy('created_at', 'asc')
    .select('id', 'role', 'agent', 'intent', 'content', 'feedback', 'feedback_correction', 'created_at');
  return res.status(200).json({ success: true, data: { conversation: conv, messages } });
});

/**
 * POST /knowledge/__conversations/:convId/messages/:msgId/feedback
 * Body: { feedback: 'up' | 'down', correction?: string }
 */
router.post('/__conversations/:convId/messages/:msgId/feedback', requirePermission('inbox.reply'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { convId, msgId } = req.params as { convId: string; msgId: string };
  const { feedback, correction } = req.body;

  if (!['up', 'down'].includes(feedback)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID', message: 'feedback must be up or down' } });
  }

  // Verify the message belongs to this tenant
  const msg = await db('chat_messages')
    .where({ id: msgId, conversation_id: convId, tenant_id: tenantId })
    .first();
  if (!msg) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Message not found' } });

  await db('chat_messages').where({ id: msgId }).update({
    feedback,
    feedback_correction: correction?.trim() || null,
    feedback_by: req.tenant!.userId || null,
    feedback_at: new Date(),
  });

  // If thumbs down with a correction, also create an agent_correction for few-shot learning
  if (feedback === 'down' && correction?.trim() && msg.agent) {
    // Find the user message that preceded this assistant message
    const prevUserMsg = await db('chat_messages')
      .where({ conversation_id: convId, role: 'user' })
      .where('created_at', '<', msg.created_at)
      .orderBy('created_at', 'desc')
      .first();

    if (prevUserMsg) {
      // Find the agent run for this message (if recorded)
      const run = await db('agent_runs')
        .where({ tenant_id: tenantId, agent: msg.agent })
        .where('created_at', '>=', new Date(new Date(msg.created_at).getTime() - 5000))
        .where('created_at', '<=', new Date(new Date(msg.created_at).getTime() + 5000))
        .first();

      await db('agent_corrections').insert({
        tenant_id: tenantId,
        run_id: run?.id || null,
        agent: msg.agent,
        original_input: (prevUserMsg.content || '').substring(0, 4000),
        original_output: (msg.content || '').substring(0, 4000),
        corrected_output: correction.trim(),
        correction_note: 'From inbox feedback (thumbs down)',
        active: true,
      }).onConflict().ignore(); // avoid duplicates if user clicks twice
    }
  }

  return res.status(200).json({ success: true, data: { message: 'Feedback saved' } });
});

// --- internals ---

async function ensureManualSource(tenantId: string): Promise<any> {
  const db = getDb();
  const existing = await db('tenant_knowledge_sources')
    .where({ tenant_id: tenantId, source_type: 'manual' })
    .first();
  if (existing) return existing;
  const [row] = await db('tenant_knowledge_sources').insert({
    tenant_id: tenantId,
    source_type: 'manual',
    label: 'Manual entries',
    status: 'completed',
  }).returning('*');
  return row;
}

/**
 * GET /knowledge/health
 *
 * Quick readiness check for the chatbot knowledge base.
 * Returns counts so the dashboard can show a "your chatbot has nothing to work
 * with yet" banner before customers start asking questions and getting "I don't know".
 *
 * status:
 *   - "healthy"  : sources>=1, docs>=10, embedded_pct>=0.5
 *   - "warming"  : sources>=1 but embeddings still catching up
 *   - "empty"    : no sources / no docs
 */
router.get('/health', requirePermission('knowledge.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const sourceRows = await db('tenant_knowledge_sources')
    .where({ tenant_id: tenantId })
    .select('status');
  const sources = {
    total: sourceRows.length,
    completed: sourceRows.filter((s: any) => s.status === 'completed').length,
    syncing: sourceRows.filter((s: any) => s.status === 'syncing').length,
    failed: sourceRows.filter((s: any) => s.status === 'failed').length,
  };

  const [{ count: docCount }] = await db('tenant_knowledge_documents')
    .where({ tenant_id: tenantId })
    .count<{ count: string }[]>('id as count');
  const [{ count: embeddedCount }] = await db('tenant_knowledge_documents')
    .where({ tenant_id: tenantId })
    .whereNotNull('embedding')
    .count<{ count: string }[]>('id as count');
  const [{ count: dirtyCount }] = await db('tenant_knowledge_documents')
    .where({ tenant_id: tenantId, embedding_dirty: true })
    .count<{ count: string }[]>('id as count');

  const totalDocs = parseInt(docCount as string, 10) || 0;
  const embedded = parseInt(embeddedCount as string, 10) || 0;
  const pendingEmbeddings = parseInt(dirtyCount as string, 10) || 0;
  const embeddedPct = totalDocs > 0 ? embedded / totalDocs : 0;

  let status: 'healthy' | 'warming' | 'empty';
  const messages: string[] = [];
  if (sources.total === 0 || totalDocs === 0) {
    status = 'empty';
    messages.push(
      'Your chatbot has no knowledge yet. Add a website, sitemap, or upload documents under the Knowledge tab so it can answer customer questions about your store.',
    );
  } else if (totalDocs < 10) {
    status = 'warming';
    messages.push(
      `Only ${totalDocs} document chunk${totalDocs === 1 ? '' : 's'} indexed. Add more sources for better answers.`,
    );
  } else if (embeddedPct < 0.5) {
    status = 'warming';
    messages.push(
      `${embedded}/${totalDocs} documents embedded (${pendingEmbeddings} still pending). Embeddings finish in the background — give it a few minutes.`,
    );
  } else {
    status = 'healthy';
  }

  if (sources.failed > 0) {
    messages.push(`${sources.failed} knowledge source${sources.failed === 1 ? '' : 's'} failed to sync. Check the Knowledge tab to retry.`);
  }

  return res.status(200).json({
    success: true,
    data: {
      status,
      messages,
      sources,
      documents: {
        total: totalDocs,
        embedded,
        pending_embeddings: pendingEmbeddings,
        embedded_pct: embeddedPct,
      },
    },
  });
});

export default router;
