import * as cheerio from 'cheerio';

/**
 * Content extractors for different MIME types.
 * Each returns plain text suitable for the chatbot's keyword retrieval + prompting.
 */

export interface ExtractedContent {
  title: string;
  text: string;
  links?: string[];   // only set for sitemap pages
}

/**
 * HTML extractor: pulls main content and strips script/style/nav/footer cruft.
 * Falls back to body text if no main element exists.
 */
export function extractHtml(html: string, fallbackTitle = ''): ExtractedContent {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg, form, nav, header, footer, aside').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || fallbackTitle;

  // Prefer main content elements
  let scope = $('main').first();
  if (!scope.length) scope = $('article').first();
  if (!scope.length) scope = $('[role="main"]').first();
  if (!scope.length) scope = $('body');

  const text = scope.text().replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return { title, text };
}

/**
 * Sitemap parser. Extracts <loc> URLs from a standard sitemap.xml.
 * Supports nested sitemap indexes (returns the inner sitemap URLs as links).
 */
export function extractSitemap(xml: string): ExtractedContent {
  const $ = cheerio.load(xml, { xmlMode: true });
  const locs: string[] = [];
  $('url > loc, sitemap > loc').each((_i: number, el: any) => {
    const v = $(el).text().trim();
    if (v) locs.push(v);
  });
  return {
    title: 'Sitemap',
    text: locs.join('\n'),
    links: locs,
  };
}

/**
 * PDF extractor — uses pdf-parse. Only loads the dep on demand to avoid
 * paying its startup cost when the tenant doesn't use PDFs.
 */
export async function extractPdf(buffer: Buffer): Promise<ExtractedContent> {
  // Lazy require to avoid issues when pdf-parse isn't installed in some environments
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  const text = (result.text || '').replace(/\n{3,}/g, '\n\n').trim();
  const title = result.info?.Title?.trim() || '';
  return { title, text };
}

/**
 * Plain text extractor.
 */
export function extractText(buffer: Buffer): ExtractedContent {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').trim();
  return { title: '', text };
}

/**
 * Chunk a long body into reasonably-sized pieces for retrieval.
 * Targets ~1000 chars per chunk, on paragraph boundaries when possible.
 */
export function chunkText(text: string, maxLen = 1000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf.length + p.length + 2 > maxLen && buf.length > 0) {
      chunks.push(buf.trim());
      buf = '';
    }
    if (p.length > maxLen) {
      // Split on sentence boundaries
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (buf.length + s.length + 1 > maxLen && buf.length > 0) {
          chunks.push(buf.trim());
          buf = '';
        }
        buf += (buf ? ' ' : '') + s;
      }
    } else {
      buf += (buf ? '\n\n' : '') + p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
