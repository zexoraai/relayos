import https from 'https';
import http from 'http';
import { URL } from 'url';

/**
 * Minimal HTTP fetcher for crawling.
 * - Follows up to 5 redirects.
 * - Caps content at 5MB to prevent memory blowups.
 * - Returns content_type + body buffer.
 */
export interface FetchResult {
  url: string;
  status: number;
  content_type: string;
  body: Buffer;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;

export async function fetchUrl(rawUrl: string): Promise<FetchResult> {
  // Shopify optimization: try .json endpoint first for pages/products/blogs
  const shopifyJson = await tryShopifyJsonEndpoint(rawUrl);
  if (shopifyJson) return shopifyJson;

  let current = rawUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await fetchOnce(current);
    if (result.status >= 300 && result.status < 400 && result.location) {
      current = new URL(result.location, current).toString();
      continue;
    }
    return result;
  }
  throw new Error(`Too many redirects from ${rawUrl}`);
}

interface FetchOnceResult extends FetchResult { location?: string; }

function fetchOnce(rawUrl: string): Promise<FetchOnceResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'RelayOS-KnowledgeBot/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/pdf,text/plain,*/*;q=0.1',
        'Accept-Language': 'en',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          req.destroy();
          reject(new Error(`Response exceeds ${MAX_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          url: rawUrl,
          status: res.statusCode || 0,
          content_type: String(res.headers['content-type'] || ''),
          body: Buffer.concat(chunks),
          location: res.headers.location ? String(res.headers.location) : undefined,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out fetching ${rawUrl}`)); });
    req.end();
  });
}


/**
 * Shopify stores serve page/product/blog content at {url}.json
 * This returns structured data without needing JavaScript rendering.
 *
 * Detects Shopify URLs by path pattern:
 *   /pages/{handle} → /pages/{handle}.json → { page: { title, body_html } }
 *   /products/{handle} → /products/{handle}.json → { product: { title, body_html, variants } }
 *   /blogs/{blog}/{article} → /blogs/{blog}/{article}.json → { article: { title, body_html } }
 *   /collections/{handle} → /collections/{handle}.json → { collection: { title, body_html } }
 */
async function tryShopifyJsonEndpoint(rawUrl: string): Promise<FetchResult | null> {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname;

    // Only try for known Shopify content paths
    const shopifyPaths = ['/pages/', '/products/', '/blogs/', '/collections/'];
    const isShopifyContent = shopifyPaths.some(p => path.startsWith(p));
    if (!isShopifyContent) return null;

    // Don't double-append .json
    const jsonUrl = path.endsWith('.json') ? rawUrl : rawUrl.replace(/\/?$/, '.json');

    const result = await fetchOnce(jsonUrl);
    if (result.status !== 200) return null;

    // Parse the JSON response and convert to HTML-like content for the extractor
    const parsed = JSON.parse(result.body.toString('utf8'));
    let title = '';
    let bodyHtml = '';

    if (parsed.page) {
      title = parsed.page.title || '';
      bodyHtml = parsed.page.body_html || '';
    } else if (parsed.product) {
      title = parsed.product.title || '';
      bodyHtml = parsed.product.body_html || '';
      // Append variant info
      if (Array.isArray(parsed.product.variants)) {
        bodyHtml += '<h3>Variants</h3><ul>';
        for (const v of parsed.product.variants) {
          bodyHtml += `<li>${v.title || 'Default'}: R${v.price}${v.available === false ? ' (out of stock)' : ''}</li>`;
        }
        bodyHtml += '</ul>';
      }
    } else if (parsed.article) {
      title = parsed.article.title || '';
      bodyHtml = parsed.article.body_html || '';
    } else if (parsed.collection) {
      title = parsed.collection.title || '';
      bodyHtml = parsed.collection.body_html || '';
    } else {
      return null; // Unknown structure
    }

    if (!bodyHtml && !title) return null;

    // Wrap in minimal HTML so the extractor can process it
    const html = `<html><head><title>${title}</title></head><body><h1>${title}</h1>${bodyHtml}</body></html>`;

    return {
      url: rawUrl,
      status: 200,
      content_type: 'text/html',
      body: Buffer.from(html, 'utf8'),
    };
  } catch {
    return null; // Silently fall back to normal fetch
  }
}
