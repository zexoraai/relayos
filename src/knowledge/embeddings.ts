import https from 'https';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'knowledge:embeddings' });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate an embedding vector for a text string using OpenAI's embedding API.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY required for embeddings');

  const payload = JSON.stringify({
    model: EMBEDDING_MODEL,
    input: text.substring(0, 8000), // API limit
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Embedding API ${res.statusCode}: ${data.substring(0, 200)}`));
        try {
          const parsed = JSON.parse(data);
          const vector = parsed.data?.[0]?.embedding;
          if (!vector) return reject(new Error('No embedding in response'));
          resolve(vector);
        } catch (e: any) { reject(new Error(`Embedding parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Embedding API timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search knowledge documents by embedding similarity.
 * Falls back to keyword search if embeddings aren't available.
 */
export async function searchByEmbedding(tenantId: string, query: string, limit = 4): Promise<Array<{
  id: string; title: string; category: string | null; body: string; source_url: string | null; score: number;
}>> {
  const db = getDb();

  // Generate query embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch (err: any) {
    log.warn({ error: err.message }, 'Embedding generation failed — falling back to keyword search');
    return []; // caller will fall back to keyword search
  }

  // Load all docs with embeddings for this tenant
  const docs = await db('tenant_knowledge_documents')
    .where({ tenant_id: tenantId, enabled: true })
    .whereNotNull('embedding')
    .select('id', 'title', 'category', 'body', 'source_url', 'embedding');

  if (docs.length === 0) return [];

  // Compute similarity scores
  const scored = docs.map((d: any) => {
    const emb = typeof d.embedding === 'string' ? JSON.parse(d.embedding) : d.embedding;
    const score = cosineSimilarity(queryEmbedding, emb);
    return { id: d.id, title: d.title, category: d.category, body: d.body, source_url: d.source_url, score };
  });

  // Sort by score descending, return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).filter(d => d.score > 0.3); // threshold: ignore very low matches
}

/**
 * Background job: embed all documents that have embedding_dirty = true.
 * Called periodically or after ingestion.
 */
export async function embedDirtyDocuments(batchSize = 20): Promise<number> {
  const db = getDb();
  const dirty = await db('tenant_knowledge_documents')
    .where({ embedding_dirty: true, enabled: true })
    .limit(batchSize)
    .select('id', 'title', 'body');

  if (dirty.length === 0) return 0;

  let embedded = 0;
  for (const doc of dirty) {
    try {
      const text = `${doc.title}\n\n${doc.body}`.substring(0, 8000);
      const vector = await generateEmbedding(text);
      await db('tenant_knowledge_documents').where({ id: doc.id }).update({
        embedding: JSON.stringify(vector),
        embedding_dirty: false,
      });
      embedded++;
    } catch (err: any) {
      log.warn({ docId: doc.id, error: err.message }, 'Failed to embed document');
    }
  }

  log.info({ embedded, total: dirty.length }, 'Embedding batch completed');
  return embedded;
}
