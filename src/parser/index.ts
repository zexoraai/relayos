import { simpleParser, ParsedMail, Attachment } from 'mailparser';
import crypto from 'crypto';
import { MalformedEmailError } from '../errors';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'parser' });

export interface ParsedEmail {
  messageId: string | null;
  sender: string | null;
  senderNormalized: string | null;
  recipients: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  subjectNormalized: string | null;
  date: Date | null;
  bodyText: string | null;
  bodyHtml: string | null;
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
  contentHash: string;
  rawSize: number;
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  size: number;
  content: Buffer;
  checksumSha256: string;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.trim().toLowerCase().replace(/\s+/g, '');
}

export function normalizeSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  return subject
    .replace(/^(re|fw|fwd|aw|wg):\s*/gi, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function extractAddresses(field: any): string[] {
  if (!field) return [];
  if (Array.isArray(field)) {
    return field.flatMap((item) => {
      if (typeof item === 'string') return [normalizeEmail(item)!].filter(Boolean);
      if (item?.address) return [normalizeEmail(item.address)!].filter(Boolean);
      if (item?.value) return item.value.map((v: any) => normalizeEmail(v.address)).filter(Boolean);
      return [];
    });
  }
  if (field?.value) {
    return field.value.map((v: any) => normalizeEmail(v.address)).filter(Boolean);
  }
  if (typeof field === 'string') {
    return [normalizeEmail(field)!].filter(Boolean);
  }
  return [];
}

function extractSender(from: any): string | null {
  if (!from) return null;
  if (from.value && from.value.length > 0) {
    return from.value[0].address || null;
  }
  if (typeof from === 'string') return from;
  return null;
}

function computeContentHash(parsed: ParsedMail): string {
  const hashInput = [
    extractSender(parsed.from) || '',
    parsed.subject || '',
    parsed.text || '',
    parsed.date?.toISOString() || '',
  ].join('|');

  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

function computeAttachmentChecksum(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function extractHeaders(parsed: ParsedMail): Record<string, string> {
  const headers: Record<string, string> = {};
  if (parsed.headers) {
    parsed.headers.forEach((value: any, key: string) => {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (value && typeof value === 'object') {
        headers[key] = JSON.stringify(value);
      }
    });
  }
  return headers;
}

export async function parseEmail(rawSource: Buffer | string): Promise<ParsedEmail> {
  try {
    const parsed = await simpleParser(rawSource);

    const sender = extractSender(parsed.from);
    const senderNormalized = normalizeEmail(sender);
    const subject = parsed.subject || null;
    const subjectNormalized = normalizeSubject(subject);
    const messageId = parsed.messageId || null;
    const date = parsed.date || null;

    const recipients = extractAddresses(parsed.to);
    const cc = extractAddresses(parsed.cc);
    const bcc = extractAddresses(parsed.bcc);

    const bodyText = parsed.text || null;
    const bodyHtml = parsed.html || null;

    const contentHash = computeContentHash(parsed);

    const attachments: ParsedAttachment[] = (parsed.attachments || []).map((att: Attachment) => ({
      filename: att.filename || null,
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || att.content.length,
      content: att.content,
      checksumSha256: computeAttachmentChecksum(att.content),
    }));

    const rawSize = typeof rawSource === 'string' ? Buffer.byteLength(rawSource) : rawSource.length;

    return {
      messageId,
      sender,
      senderNormalized,
      recipients,
      cc,
      bcc,
      subject,
      subjectNormalized,
      date,
      bodyText,
      bodyHtml,
      headers: extractHeaders(parsed),
      attachments,
      contentHash,
      rawSize,
    };
  } catch (error: any) {
    log.error({ error: error.message }, 'Failed to parse email');
    throw new MalformedEmailError(`Failed to parse email: ${error.message}`, {
      originalError: error.message,
    });
  }
}
