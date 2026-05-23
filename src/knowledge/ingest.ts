import { createHash } from 'crypto';
import https from 'https';
import { URL } from 'url';
import { getDb } from '../db/connection';
import { decrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';
import { fetchUrl } from './fetcher';
import { extractHtml, extractSitemap, extractPdf, extractText, chunkText, ExtractedContent } from './extractor';

const log = createChildLogger({ module: 'knowledge:ingest' });

export interface IngestSummary {
  source_id: string;
  documents_added: number;
  documents_updated: number;
  documents_unchanged: number;
  errors: string[];
}

interface SourceRow {
  id: string;
  tenant_id: string;
  source_type: string;
  label: string;
  source_url: string | null;
  config: any;
}

/**
 * Ingest a single URL. Stores one document for the page.
 */
export async function ingestUrl(args: {
  tenantId: string;
  sourceUrl: string;
  label?: string;
  category?: string | null;
}): Promise<IngestSummary> {
  const db = getDb();

  const source = await ensureSource(args.tenantId, {
    source_type: 'url',
    label: args.label || args.sourceUrl,
    source_url: args.sourceUrl,
    config: { category: args.category || null },
  });

  await markSyncing(source.id);
  try {
    const fetched = await fetchUrl(args.sourceUrl);
    if (fetched.status >= 400) {
      throw new Error(`Fetch failed (${fetched.status})`);
    }

    const ct = fetched.content_type.toLowerCase();
    let extracted: ExtractedContent;
    if (ct.includes('application/pdf')) {
      extracted = await extractPdf(fetched.body);
    } else if (ct.includes('html') || ct.includes('xml')) {
      extracted = extractHtml(fetched.body.toString('utf8'), args.label || '');
    } else if (ct.includes('text/')) {
      extracted = extractText(fetched.body);
    } else {
      throw new Error(`Unsupported content-type: ${fetched.content_type}`);
    }

    const summary = await upsertDocuments({
      tenantId: args.tenantId,
      sourceId: source.id,
      sourceUrl: args.sourceUrl,
      title: extracted.title || args.label || args.sourceUrl,
      category: args.category || 'web',
      text: extracted.text,
    });

    await markCompleted(source.id, summary);
    return summary;
  } catch (err: any) {
    await markFailed(source.id, err.message);
    return { source_id: source.id, documents_added: 0, documents_updated: 0, documents_unchanged: 0, errors: [err.message] };
  }
}

/**
 * Ingest a sitemap URL. Fetches the sitemap, then ingests each URL it lists.
 * Caps at maxPages to avoid runaway crawls.
 */
export async function ingestSitemap(args: {
  tenantId: string;
  sitemapUrl: string;
  label?: string;
  maxPages?: number;
  pathPrefix?: string;
}): Promise<IngestSummary> {
  const db = getDb();
  const maxPages = Math.min(args.maxPages || 200, 500);

  const source = await ensureSource(args.tenantId, {
    source_type: 'sitemap',
    label: args.label || args.sitemapUrl,
    source_url: args.sitemapUrl,
    config: { max_pages: maxPages, path_prefix: args.pathPrefix || null },
  });

  await markSyncing(source.id);
  try {
    /**
     * Resolve all leaf page URLs by recursively expanding sitemap-indexes.
     * Shopify and most modern sites use a top-level sitemap.xml that points to
     * per-section sitemaps (sitemap_products_1.xml, sitemap_pages_1.xml, …).
     * Each of those then contains the actual page URLs.
     *
     * A "leaf" URL is anything that is not itself a sitemap-XML.
     */
    const visited = new Set<string>();
    const leafUrls: string[] = [];

    const expandSitemap = async (url: string, depth: number): Promise<void> => {
      if (depth > 4) return; // safety
      if (visited.has(url)) return;
      visited.add(url);
      const fetched = await fetchUrl(url);
      if (fetched.status >= 400) return;
      const text = fetched.body.toString('utf8');
      const sm = extractSitemap(text);
      const links = sm.links || [];
      // Heuristic: if the URL or its links look like sitemaps (path matches *sitemap*.xml),
      // treat it as a sitemap-index and recurse. Otherwise its links are leaf pages.
      const looksLikeSitemap = (u: string) => /sitemap[^/]*\.xml(\?|$)/i.test(u);

      if (links.length === 0) {
        // No <loc> children — treat the URL itself as a leaf page if it isn't a sitemap.
        if (!looksLikeSitemap(url)) leafUrls.push(url);
        return;
      }
      for (const child of links) {
        if (looksLikeSitemap(child)) {
          await expandSitemap(child, depth + 1);
        } else {
          leafUrls.push(child);
        }
      }
    };

    await expandSitemap(args.sitemapUrl, 0);

    let urls = leafUrls;
    if (args.pathPrefix) {
      const prefix = args.pathPrefix;
      urls = urls.filter((u) => {
        try { return new URL(u).pathname.startsWith(prefix); } catch { return false; }
      });
    }
    // De-duplicate after expansion
    urls = Array.from(new Set(urls));
    if (urls.length > maxPages) urls = urls.slice(0, maxPages);

    log.info({ sitemapUrl: args.sitemapUrl, leafCount: leafUrls.length, fetchedCount: urls.length }, 'Sitemap expansion complete');

    const aggregate: IngestSummary = {
      source_id: source.id,
      documents_added: 0,
      documents_updated: 0,
      documents_unchanged: 0,
      errors: [],
    };

    for (const u of urls) {
      try {
        const fetchedPage = await fetchUrl(u);
        if (fetchedPage.status >= 400) { aggregate.errors.push(`${u}: ${fetchedPage.status}`); continue; }
        const ct = fetchedPage.content_type.toLowerCase();
        let extracted: ExtractedContent;
        if (ct.includes('application/pdf')) extracted = await extractPdf(fetchedPage.body);
        else if (ct.includes('html')) extracted = extractHtml(fetchedPage.body.toString('utf8'), u);
        else if (ct.includes('text/')) extracted = extractText(fetchedPage.body);
        else { aggregate.errors.push(`${u}: unsupported ct ${fetchedPage.content_type}`); continue; }

        // Skip pages with too little extractable text — usually 404 / SPA shells.
        if (!extracted.text || extracted.text.trim().length < 80) {
          aggregate.errors.push(`${u}: empty body`);
          continue;
        }

        const sub = await upsertDocuments({
          tenantId: args.tenantId,
          sourceId: source.id,
          sourceUrl: u,
          title: extracted.title || u,
          category: 'web',
          text: extracted.text,
        });
        aggregate.documents_added += sub.documents_added;
        aggregate.documents_updated += sub.documents_updated;
        aggregate.documents_unchanged += sub.documents_unchanged;
        aggregate.errors.push(...sub.errors);
      } catch (err: any) {
        aggregate.errors.push(`${u}: ${err.message}`);
      }
    }

    // Prune docs from previous syncs whose URL isn't in this run.
    // Catches stale sitemap-XML docs left behind by the old (non-recursive) crawler.
    if (urls.length > 0) {
      const visitedUrls = new Set(urls);
      const stale = await db('tenant_knowledge_documents')
        .where({ source_id: source.id })
        .whereNotIn('source_url', Array.from(visitedUrls))
        .select('id', 'source_url');
      if (stale.length > 0) {
        await db('tenant_knowledge_documents')
          .whereIn('id', stale.map((s: any) => s.id))
          .delete();
        log.info({ sourceId: source.id, prunedCount: stale.length }, 'Pruned stale knowledge documents from prior crawl');
      }
    }

    await markCompleted(source.id, aggregate);
    return aggregate;
  } catch (err: any) {
    await markFailed(source.id, err.message);
    return { source_id: source.id, documents_added: 0, documents_updated: 0, documents_unchanged: 0, errors: [err.message] };
  }
}

/**
 * Ingest an uploaded file (already in memory).
 */
export async function ingestFile(args: {
  tenantId: string;
  fileName: string;
  mime: string;
  buffer: Buffer;
  category?: string | null;
}): Promise<IngestSummary> {
  const db = getDb();
  const source = await ensureSource(args.tenantId, {
    source_type: 'upload',
    label: args.fileName,
    source_url: null,
    config: { category: args.category || null, mime: args.mime, size: args.buffer.length },
  });
  // Store file metadata
  await db('tenant_knowledge_sources').where({ id: source.id }).update({
    file_name: args.fileName,
    file_mime: args.mime,
    file_size_bytes: args.buffer.length,
  });

  await markSyncing(source.id);
  try {
    let extracted: ExtractedContent;
    if (args.mime.includes('pdf')) extracted = await extractPdf(args.buffer);
    else if (args.mime.startsWith('text/') || args.mime.includes('html') || args.mime.includes('xml')) {
      extracted = args.mime.includes('html')
        ? extractHtml(args.buffer.toString('utf8'), args.fileName)
        : extractText(args.buffer);
    } else {
      throw new Error(`Unsupported file type: ${args.mime}`);
    }

    const summary = await upsertDocuments({
      tenantId: args.tenantId,
      sourceId: source.id,
      sourceUrl: null,
      title: extracted.title || args.fileName,
      category: args.category || 'upload',
      text: extracted.text,
    });
    await markCompleted(source.id, summary);
    return summary;
  } catch (err: any) {
    await markFailed(source.id, err.message);
    return { source_id: source.id, documents_added: 0, documents_updated: 0, documents_unchanged: 0, errors: [err.message] };
  }
}

/**
 * Sync the tenant's Shopify product catalog into the knowledge base.
 * One document per product. Uses the existing tenant_shopify_api_settings.
 */
export async function ingestShopifyProducts(args: { tenantId: string; maxProducts?: number }): Promise<IngestSummary> {
  const db = getDb();
  const apiSettings = await db('tenant_shopify_api_settings').where({ tenant_id: args.tenantId }).first();
  if (!apiSettings) {
    throw new Error('Shopify API not configured for tenant');
  }
  const store = apiSettings.shopify_store;
  const token = decrypt(apiSettings.encrypted_access_token);
  const max = args.maxProducts || 250;

  const source = await ensureSource(args.tenantId, {
    source_type: 'shopify_products',
    label: `Shopify products (${store})`,
    source_url: `https://${store.includes('.') ? store : store + '.myshopify.com'}/products`,
    config: { max },
  });

  await markSyncing(source.id);
  try {
    const products = await fetchShopifyProducts(store, token, max);
    const aggregate: IngestSummary = {
      source_id: source.id,
      documents_added: 0,
      documents_updated: 0,
      documents_unchanged: 0,
      errors: [],
    };

    for (const p of products) {
      const url = `https://${store.includes('.') ? store : store + '.myshopify.com'}/products/${p.handle}`;
      const lines: string[] = [];
      lines.push(`Product: ${p.title}`);
      if (p.product_type) lines.push(`Type: ${p.product_type}`);
      if (p.tags) lines.push(`Tags: ${p.tags}`);
      if (p.body_html) lines.push('\n' + stripHtml(p.body_html));
      if (Array.isArray(p.variants) && p.variants.length) {
        lines.push('\nVariants:');
        for (const v of p.variants) {
          lines.push(`- ${v.title || 'Default'}: R${v.price}${v.sku ? ' (SKU ' + v.sku + ')' : ''}${v.available === false ? ' (out of stock)' : ''}`);
        }
      }
      const text = lines.join('\n');

      const sub = await upsertDocuments({
        tenantId: args.tenantId,
        sourceId: source.id,
        sourceUrl: url,
        title: p.title,
        category: 'product',
        text,
      });
      aggregate.documents_added += sub.documents_added;
      aggregate.documents_updated += sub.documents_updated;
      aggregate.documents_unchanged += sub.documents_unchanged;
      aggregate.errors.push(...sub.errors);
    }

    await markCompleted(source.id, aggregate);
    return aggregate;
  } catch (err: any) {
    await markFailed(source.id, err.message);
    return { source_id: source.id, documents_added: 0, documents_updated: 0, documents_unchanged: 0, errors: [err.message] };
  }
}

/**
 * Re-run ingestion for an existing source.
 */
export async function resyncSource(tenantId: string, sourceId: string): Promise<IngestSummary> {
  const db = getDb();
  const src: SourceRow | undefined = await db('tenant_knowledge_sources')
    .where({ id: sourceId, tenant_id: tenantId })
    .first();
  if (!src) throw new Error('Source not found');

  switch (src.source_type) {
    case 'url':
      return ingestUrl({ tenantId, sourceUrl: src.source_url!, label: src.label, category: src.config?.category || null });
    case 'sitemap':
      return ingestSitemap({ tenantId, sitemapUrl: src.source_url!, label: src.label, maxPages: src.config?.max_pages || 50, pathPrefix: src.config?.path_prefix || undefined });
    case 'shopify_products':
      return ingestShopifyProducts({ tenantId, maxProducts: src.config?.max || 250 });
    default:
      throw new Error(`Source type ${src.source_type} cannot be re-synced`);
  }
}

// ----- internals -----

async function ensureSource(tenantId: string, fields: Partial<SourceRow> & { source_type: string; label: string; source_url: string | null; config: any }): Promise<SourceRow> {
  const db = getDb();
  // For URL/sitemap, dedupe on source_url so re-adding the same URL updates instead of duplicating.
  if (fields.source_type === 'url' || fields.source_type === 'sitemap') {
    const existing = await db('tenant_knowledge_sources')
      .where({ tenant_id: tenantId, source_type: fields.source_type, source_url: fields.source_url || '' })
      .first();
    if (existing) return existing;
  }
  if (fields.source_type === 'shopify_products') {
    const existing = await db('tenant_knowledge_sources').where({ tenant_id: tenantId, source_type: 'shopify_products' }).first();
    if (existing) return existing;
  }
  const [row] = await db('tenant_knowledge_sources').insert({
    tenant_id: tenantId,
    source_type: fields.source_type,
    label: fields.label,
    source_url: fields.source_url,
    config: JSON.stringify(fields.config || {}),
  }).returning('*');
  return row;
}

async function markSyncing(sourceId: string) {
  await getDb()('tenant_knowledge_sources').where({ id: sourceId }).update({ status: 'syncing', last_error: null, updated_at: new Date() });
}

async function markCompleted(sourceId: string, summary: IngestSummary) {
  const db = getDb();
  const docs = await db('tenant_knowledge_documents').where({ source_id: sourceId }).count<{ count: string }[]>('id as count');
  await db('tenant_knowledge_sources').where({ id: sourceId }).update({
    status: 'completed',
    document_count: parseInt(docs[0]?.count || '0', 10),
    last_synced_at: new Date(),
    last_error: summary.errors.length ? summary.errors.slice(0, 3).join(' | ') : null,
    updated_at: new Date(),
  });
}

async function markFailed(sourceId: string, error: string) {
  await getDb()('tenant_knowledge_sources').where({ id: sourceId }).update({
    status: 'failed',
    last_error: error,
    updated_at: new Date(),
  });
}

interface UpsertArgs {
  tenantId: string;
  sourceId: string;
  sourceUrl: string | null;
  title: string;
  category: string;
  text: string;
}

/**
 * Splits text into chunks and upserts each chunk as a document.
 * If a chunk's content_hash matches an existing one for (source_id, chunk_index), we mark unchanged.
 */
async function upsertDocuments(args: UpsertArgs): Promise<IngestSummary> {
  const db = getDb();
  const chunks = chunkText(args.text);

  const summary: IngestSummary = {
    source_id: args.sourceId,
    documents_added: 0,
    documents_updated: 0,
    documents_unchanged: 0,
    errors: [],
  };

  if (chunks.length === 0) {
    summary.errors.push(`Empty content for ${args.sourceUrl || args.title}`);
    return summary;
  }

  // Remove orphaned chunks if we re-ingest with fewer chunks
  const existingForUrl = await db('tenant_knowledge_documents')
    .where({ source_id: args.sourceId, source_url: args.sourceUrl })
    .select('id', 'chunk_index', 'content_hash');

  const seenIndices = new Set<number>();

  for (let i = 0; i < chunks.length; i++) {
    const body = chunks[i];
    const contentHash = createHash('sha1').update(body).digest('hex');
    seenIndices.add(i);

    const existing = existingForUrl.find((e: any) => e.chunk_index === i);
    const titleForChunk = chunks.length === 1 ? args.title : `${args.title} (part ${i + 1})`;

    if (existing) {
      if (existing.content_hash === contentHash) {
        summary.documents_unchanged++;
        await db('tenant_knowledge_documents').where({ id: existing.id }).update({ last_synced_at: new Date() });
      } else {
        await db('tenant_knowledge_documents').where({ id: existing.id }).update({
          title: titleForChunk,
          body,
          category: args.category,
          content_hash: contentHash,
          last_synced_at: new Date(),
          updated_at: new Date(),
        });
        summary.documents_updated++;
      }
    } else {
      await db('tenant_knowledge_documents').insert({
        tenant_id: args.tenantId,
        source_id: args.sourceId,
        source_url: args.sourceUrl,
        title: titleForChunk,
        category: args.category,
        body,
        chunk_index: i,
        content_hash: contentHash,
        last_synced_at: new Date(),
        enabled: true,
      });
      summary.documents_added++;
    }
  }

  // Drop orphans (chunks that existed before but no longer)
  const toDelete = existingForUrl.filter((e: any) => !seenIndices.has(e.chunk_index)).map((e: any) => e.id);
  if (toDelete.length) {
    await db('tenant_knowledge_documents').whereIn('id', toDelete).delete();
  }

  return summary;
}

function fetchShopifyProducts(store: string, token: string, max: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const hostname = store.includes('.') ? store : `${store}.myshopify.com`;
    const limit = Math.min(max, 250);
    const path = `/admin/api/2024-01/products.json?limit=${limit}&fields=id,title,handle,product_type,tags,body_html,variants`;

    const req = https.request({
      hostname,
      path,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Shopify products API ${res.statusCode}`));
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.products || []);
        } catch (e: any) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Shopify products timed out')); });
    req.end();
  });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
