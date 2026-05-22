import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { chatCompletion, ChatMessage } from '../ai/openai';
import { getActiveCorrections, buildCorrectionMessages } from '../ai/runRecorder';
import { searchByEmbedding } from '../knowledge/embeddings';

const log = createChildLogger({ module: 'chatbot:tenant-info' });

export interface TenantInfoInput {
  tenantId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
}

export interface TenantInfoResult {
  reply: string;
  used_documents: Array<{ id: string; title: string; category: string | null }>;
  confidence: 'high' | 'low';
}

/**
 * Tenant Info Chatbot
 * Answers questions about the tenant's policies, FAQs, shipping info, etc.
 * Uses keyword retrieval over tenant_knowledge_documents + LLM answer with strict grounding.
 */
export async function runTenantInfo(input: TenantInfoInput): Promise<TenantInfoResult> {
  const db = getDb();

  // Try embedding-based search first (semantic), fall back to keyword scoring
  let ranked: Array<{ id: string; title: string; category: string | null; body: string; source_url?: string | null; score: number }> = [];

  const embeddingResults = await searchByEmbedding(input.tenantId, input.message, 4);
  if (embeddingResults.length > 0) {
    ranked = embeddingResults;
    log.debug({ count: ranked.length, topScore: ranked[0]?.score }, 'Using embedding search');
  } else {
    // Fallback: keyword scoring
    const docs = await db('tenant_knowledge_documents')
      .where({ tenant_id: input.tenantId, enabled: true })
      .select('id', 'title', 'category', 'body', 'source_url');

    if (docs.length === 0) {
      return {
        reply: "I don't have store information set up yet. A team member will get back to you shortly.",
        used_documents: [],
        confidence: 'low',
      };
    }

    ranked = rankDocsByKeywords(docs, input.message).slice(0, 4);
    if (ranked.length === 0) {
      ranked.push(...docs.slice(0, 2).map((d: any) => ({ ...d, score: 0 })));
    }
  }

  const knowledgeBlock = ranked.map((d, i) =>
    `[Doc ${i + 1}] ${d.title}${d.category ? ' (' + d.category + ')' : ''}${d.source_url ? ' [' + d.source_url + ']' : ''}\n${d.body.substring(0, 1200)}`
  ).join('\n\n---\n\n');

  // Load corrections for this agent
  const corrections = await getActiveCorrections('tenant_info', input.tenantId, 5);
  const correctionMessages = buildCorrectionMessages(corrections);

  // Load custom instructions
  const chatSettings = await db('chatbot_settings').where({ tenant_id: input.tenantId }).first();
  const customInstructions = chatSettings?.custom_instructions || '';
  const botName = chatSettings?.bot_name || '';

  let systemPromptText = `You are ${botName || 'a helpful store assistant'} answering questions over WhatsApp. You have access to the store's knowledge base below.

Strict rules:
- Only answer using the knowledge base. Never invent policies, prices, or timeframes.
- If the answer is not in the knowledge base, say so clearly and offer to escalate to a human.
- Keep replies short (1-3 sentences) and friendly.
- Use plain text only — no markdown.
- If quoting timeframes or amounts, copy them exactly from the knowledge base.${customInstructions ? '\n\nAdditional instructions:\n' + customInstructions : ''}

Knowledge base:
${knowledgeBlock}`;

  const messages: ChatMessage[] = [{ role: 'system', content: systemPromptText }, ...correctionMessages];
  for (const h of input.history.slice(-4)) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: input.message });

  const res = await chatCompletion({ messages, temperature: 0.2, max_tokens: 400, agent: 'tenant_info', tenantId: input.tenantId });

  const reply = (res.content || '').trim() || "I don't have an answer for that. A team member will follow up.";

  // Confidence: high if any doc had a non-zero score AND reply doesn't say "don't know".
  const lower = reply.toLowerCase();
  const dunno = lower.includes("don't have") || lower.includes('not sure') || lower.includes('cannot find') || lower.includes("can't find");
  const confidence: 'high' | 'low' = ranked[0]?.score > 0 && !dunno ? 'high' : 'low';

  return {
    reply,
    used_documents: ranked.map((d: any) => ({ id: d.id, title: d.title, category: d.category })),
    confidence,
  };
}

interface ScoredDoc { id: string; title: string; category: string | null; body: string; source_url?: string | null; score: number; }

const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','at','with','by','is','are','am','was','were','be','been','do','does','did','have','has','had','my','your','our','their','his','her','it','this','that','these','those','i','you','we','they','what','when','where','why','how','can','could','would','should','will','about','as','if','so','just','from','please','hi','hello','hey','thanks','thank','your','their']);

function rankDocsByKeywords(docs: any[], query: string): ScoredDoc[] {
  const tokens = tokenize(query);
  return docs
    .map((d) => {
      const haystack = (d.title + ' ' + (d.category || '') + ' ' + d.body).toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (haystack.includes(t)) score += t.length >= 5 ? 3 : 1;
      }
      // Title matches weighted higher
      const titleLower = d.title.toLowerCase();
      for (const t of tokens) if (titleLower.includes(t)) score += 4;
      return { ...d, score } as ScoredDoc;
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
}

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}
