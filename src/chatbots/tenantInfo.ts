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

  // Build a retrieval query that's aware of conversation context.
  // For short follow-ups like "what's the cost?", "and the small one?" the
  // last turn alone doesn't have enough signal for embedding search to find
  // the right product chunk. We prepend the recent user turns so the embedding
  // captures the topic carried over from the previous message.
  const recentUserTurns = input.history
    .filter((h) => h.role === 'user')
    .slice(-3)
    .map((h) => h.content)
    .filter(Boolean);
  const recentAssistantTurns = input.history
    .filter((h) => h.role === 'assistant')
    .slice(-2)
    .map((h) => h.content)
    .filter(Boolean);
  const messageWordCount = input.message.trim().split(/\s+/).length;
  const isShortFollowUp = messageWordCount < 5;
  // For short follow-ups, blend prior turns into the query. Otherwise use the
  // message as-is so its specific keywords dominate the embedding.
  const searchQuery = isShortFollowUp
    ? [recentAssistantTurns[recentAssistantTurns.length - 1] || '', recentUserTurns.slice(-2).join(' '), input.message]
        .filter(Boolean)
        .join(' \n ')
    : input.message;

  // Try embedding-based search first (semantic), fall back to keyword scoring
  let ranked: Array<{ id: string; title: string; category: string | null; body: string; source_url?: string | null; score: number }> = [];

  const embeddingResults = await searchByEmbedding(input.tenantId, searchQuery, 6);
  if (embeddingResults.length > 0) {
    ranked = embeddingResults;
    log.debug({ count: ranked.length, topScore: ranked[0]?.score, isShortFollowUp }, 'Using embedding search');
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

    ranked = rankDocsByKeywords(docs, searchQuery).slice(0, 6);
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

  let systemPromptText = `You are ${botName || 'a helpful store assistant'} answering questions over WhatsApp. The store's knowledge base is below — use it to answer the customer's question naturally and confidently.

How to answer:
- Pull product names, prices, ingredients, descriptions, policies, hours, shipping info etc. directly from the knowledge base. If the doc says "Default Title: R55.00" that means the price is R55. Quote prices and amounts exactly as they appear.
- Be helpful and concrete. If the user asks "what is the cost of X" and a doc lists X with a price, answer with the price — don't say "I can't provide pricing".
- Keep replies short (1-3 sentences) and friendly. Plain text only.
- Honour conversation context: if the previous turn talked about Product Y and the user asks "how much?", they mean Product Y.
- If the answer genuinely isn't anywhere in the knowledge base, say "I don't have that detail — let me get a team member to follow up" instead of inventing.
- Never invent policies, prices, ingredients, or stock status that aren't in the knowledge base.${customInstructions ? '\n\nAdditional instructions:\n' + customInstructions : ''}

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
