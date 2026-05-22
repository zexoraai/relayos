import { getDb } from '../db/connection';
import { chatCompletion } from '../ai/openai';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'chatbot:summarizer' });

const SUMMARIZE_THRESHOLD = 20; // messages before we summarize
const KEEP_RECENT = 6;          // always keep the last N messages verbatim

/**
 * Conversation summarization.
 *
 * When a conversation exceeds SUMMARIZE_THRESHOLD messages, we:
 *   1. Take all messages EXCEPT the last KEEP_RECENT
 *   2. Ask the LLM to compress them into a single "context" paragraph
 *   3. Store the summary on the conversation row
 *   4. Delete the old messages (they're preserved in agent_runs if needed)
 *
 * On the next chatbot call, the summary is prepended as a system message
 * so the model has context without paying for 50+ messages of tokens.
 */

export async function maybeSummarize(conversationId: string): Promise<void> {
  const db = getDb();

  const msgCount = await db('chat_messages')
    .where({ conversation_id: conversationId })
    .count<{ count: string }[]>('id as count');
  const total = parseInt(msgCount[0]?.count || '0');

  if (total < SUMMARIZE_THRESHOLD) return;

  // Get all messages ordered by time
  const allMessages = await db('chat_messages')
    .where({ conversation_id: conversationId })
    .orderBy('created_at', 'asc')
    .select('id', 'role', 'content', 'created_at');

  if (allMessages.length < SUMMARIZE_THRESHOLD) return;

  // Split: old messages to summarize vs recent to keep
  const toSummarize = allMessages.slice(0, -KEEP_RECENT);
  const toKeep = allMessages.slice(-KEEP_RECENT);

  // Build the text to summarize
  const transcript = toSummarize
    .map((m: any) => `${m.role}: ${(m.content || '').substring(0, 300)}`)
    .join('\n');

  try {
    const result = await chatCompletion({
      agent: 'summarizer',
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: 'You are a conversation summarizer. Compress the following customer support chat into a brief context paragraph (3-5 sentences). Include: what the customer asked about, what orders/waybills were discussed, what was resolved, and any pending issues. Be factual and concise.',
        },
        { role: 'user', content: transcript.substring(0, 4000) },
      ],
    });

    const summary = (result.content || '').trim();
    if (!summary) return;

    // Store summary on the conversation
    await db('chat_conversations').where({ id: conversationId }).update({
      summary,
      summary_covers_until: toSummarize[toSummarize.length - 1].created_at,
      updated_at: new Date(),
    });

    // Delete the old messages (they're in agent_runs for audit)
    const idsToDelete = toSummarize.map((m: any) => m.id);
    await db('chat_messages').whereIn('id', idsToDelete).delete();

    log.info({
      conversationId,
      summarized: toSummarize.length,
      kept: toKeep.length,
      summaryLength: summary.length,
    }, 'Conversation summarized');
  } catch (err: any) {
    log.warn({ conversationId, error: err.message }, 'Summarization failed (non-fatal)');
  }
}

/**
 * Build the context messages for a chatbot call.
 * If a summary exists, prepend it as a system message before the recent history.
 */
export async function getConversationContext(conversationId: string): Promise<{
  summary: string | null;
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}> {
  const db = getDb();

  const conv = await db('chat_conversations').where({ id: conversationId }).first();
  const summary = conv?.summary || null;

  const recent = await db('chat_messages')
    .where({ conversation_id: conversationId })
    .orderBy('created_at', 'desc')
    .limit(KEEP_RECENT + 2) // grab a couple extra in case
    .select('role', 'content');

  const recentMessages = recent
    .reverse()
    .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  return { summary, recentMessages };
}
