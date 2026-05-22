import crypto from 'crypto';
import { Knex } from 'knex';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { emailsDuplicate } from '../observability/metrics';

const log = createChildLogger({ module: 'dedup' });

export interface DedupInput {
  mailboxId: string;
  uid: number;
  messageId: string | null;
  senderNormalized: string | null;
  subjectNormalized: string | null;
  emailDate: Date | null;
  contentHash: string;
}

/**
 * Generate a deterministic deduplication key.
 * Primary: mailbox + UID + Message-ID + sender + subject + date
 * Fallback (no Message-ID): uses content hash instead
 */
export function generateDedupKey(input: DedupInput): string {
  const parts = [
    input.mailboxId,
    String(input.uid),
  ];

  if (input.messageId) {
    parts.push(input.messageId);
  } else {
    parts.push(`hash:${input.contentHash}`);
  }

  parts.push(input.senderNormalized || '');
  parts.push(input.subjectNormalized || '');
  parts.push(input.emailDate?.toISOString() || '');

  const combined = parts.join('|');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Check if an email is a duplicate by dedup key or content hash.
 * Returns the existing email ID if duplicate, null otherwise.
 */
export async function checkDuplicate(
  dedupKey: string,
  contentHash: string,
  mailboxId: string,
  trx?: Knex
): Promise<string | null> {
  const db = trx || getDb();

  // Check by dedup key (primary)
  const byKey = await db('ingested_emails')
    .where({ dedup_key: dedupKey })
    .whereNot({ status: 'failed' })
    .first('id');

  if (byKey) {
    log.debug({ dedupKey, existingId: byKey.id }, 'Duplicate found by dedup key');
    emailsDuplicate.inc({ mailbox: mailboxId });
    return byKey.id;
  }

  // Check by content hash (secondary - catches cross-mailbox duplicates)
  const byHash = await db('ingested_emails')
    .where({ content_hash: contentHash, mailbox_id: mailboxId })
    .whereNot({ status: 'failed' })
    .first('id');

  if (byHash) {
    log.debug({ contentHash, existingId: byHash.id }, 'Duplicate found by content hash');
    emailsDuplicate.inc({ mailbox: mailboxId });
    return byHash.id;
  }

  return null;
}

/**
 * Attempt to insert a dedup record. Returns true if inserted (not duplicate),
 * false if duplicate (unique constraint violation).
 * This is the race-condition-safe path.
 */
export async function tryInsertDedupRecord(
  record: {
    id: string;
    mailboxId: string;
    uid: number;
    messageId: string | null;
    dedupKey: string;
    contentHash: string;
    senderNormalized: string | null;
    subjectNormalized: string | null;
    emailDate: Date | null;
    correlationId: string;
  },
  trx?: Knex
): Promise<boolean> {
  const db = trx || getDb();

  try {
    await db('ingested_emails').insert({
      id: record.id,
      mailbox_id: record.mailboxId,
      uid: record.uid,
      message_id: record.messageId,
      dedup_key: record.dedupKey,
      content_hash: record.contentHash,
      sender_normalized: record.senderNormalized,
      subject_normalized: record.subjectNormalized,
      email_date: record.emailDate,
      status: 'fetched',
      correlation_id: record.correlationId,
      fetched_at: new Date(),
    });
    return true;
  } catch (error: any) {
    // Unique constraint violation (PostgreSQL error code 23505)
    if (error.code === '23505') {
      log.debug({ dedupKey: record.dedupKey }, 'Duplicate insert prevented by constraint');
      emailsDuplicate.inc({ mailbox: record.mailboxId });
      return false;
    }
    throw error;
  }
}
