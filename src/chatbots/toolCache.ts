import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'chatbot:tool-cache' });

/**
 * In-memory cache for tool results within a conversation.
 * Keyed by (conversationId, toolName). Expires after 5 minutes.
 * Prevents redundant API calls when the customer asks multiple questions
 * about the same orders in quick succession.
 */

interface CacheEntry {
  result: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function makeKey(conversationId: string, toolName: string): string {
  return `${conversationId}:${toolName}`;
}

export function getCachedToolResult(conversationId: string, toolName: string): any | null {
  const key = makeKey(conversationId, toolName);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCachedToolResult(conversationId: string, toolName: string, result: any): void {
  const key = makeKey(conversationId, toolName);
  cache.set(key, { result, timestamp: Date.now() });
}

/**
 * Periodic cleanup of expired entries (call every few minutes).
 */
export function cleanupToolCache(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > TTL_MS) {
      cache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) log.debug({ cleaned }, 'Tool cache cleanup');
}
