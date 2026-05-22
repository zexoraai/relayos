import { v4 as uuidv4 } from 'uuid';
import { ImapClient } from '../imap';
import { parseEmail } from '../parser';
import { generateDedupKey, tryInsertDedupRecord } from '../dedup';
import { enqueueEmail, EmailJobData } from '../queue';
import { getDb } from '../db/connection';
import { config } from '../config';
import { createChildLogger } from '../observability/logger';
import { emailsFetched, emailsQueued } from '../observability/metrics';
import { IngestionError, ErrorType } from '../errors';

const log = createChildLogger({ module: 'ingestion-worker' });

export class IngestionWorker {
  private imapClient: ImapClient;
  private mailboxId: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(mailboxId: string) {
    this.mailboxId = mailboxId;
    this.imapClient = new ImapClient(mailboxId);
  }

  async start(): Promise<void> {
    if (!config.imap.host || !config.imap.username || !config.imap.password) {
      log.warn({ mailboxId: this.mailboxId }, 'IMAP not configured (IMAP_HOST/USERNAME/PASSWORD missing) — ingestion worker disabled');
      return;
    }
    this.running = true;
    log.info({ mailboxId: this.mailboxId }, 'Ingestion worker starting');

    await this.ensureMailboxRecord();

    try {
      await this.imapClient.connect();
    } catch (error: any) {
      log.error({ error: error.message, mailboxId: this.mailboxId }, 'Initial IMAP connection failed, will retry on next poll');
    }

    await this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.imapClient.disconnect();
    log.info({ mailboxId: this.mailboxId }, 'Ingestion worker stopped');
  }

  private async ensureMailboxRecord(): Promise<void> {
    const db = getDb();
    const existing = await db('mailboxes')
      .where({
        host: config.imap.host,
        username: config.imap.username,
        mailbox_folder: config.imap.mailbox,
      })
      .first();

    if (existing) {
      // Reuse existing mailbox ID
      (this as any).mailboxId = existing.id;
      this.imapClient = new ImapClient(existing.id);

      // Ensure offset record exists
      const offset = await db('email_ingestion_offsets').where({ mailbox_id: existing.id }).first();
      if (!offset) {
        await db('email_ingestion_offsets').insert({ mailbox_id: existing.id, last_uid: 0 });
      }
    } else {
      await db('mailboxes').insert({
        id: this.mailboxId,
        host: config.imap.host,
        port: config.imap.port,
        username: config.imap.username,
        mailbox_folder: config.imap.mailbox,
        is_active: true,
      });

      await db('email_ingestion_offsets').insert({
        mailbox_id: this.mailboxId,
        last_uid: 0,
      });
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      await this.fetchAndEnqueue();
    } catch (error: any) {
      log.error(
        { error: error.message, mailboxId: this.mailboxId },
        'Error during poll cycle'
      );

      // Reconnect on connection errors
      if (error instanceof IngestionError && error.type === ErrorType.IMAP_CONNECTION) {
        try {
          await this.imapClient.disconnect();
          await this.imapClient.connect();
        } catch (reconnectError: any) {
          log.error({ error: reconnectError.message }, 'Reconnection failed');
        }
      }
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), config.imap.pollingIntervalMs);
    }
  }

  private async fetchAndEnqueue(): Promise<void> {
    const db = getDb();

    // Get last processed UID
    const offset = await db('email_ingestion_offsets')
      .where({ mailbox_id: this.mailboxId })
      .first();

    const lastUid = Number(offset?.last_uid) || 0;

    // Check UID validity
    const uidValidity = await this.imapClient.getUidValidity();
    if (offset?.uid_validity && uidValidity && Number(offset.uid_validity) !== Number(uidValidity)) {
      log.warn(
        { mailboxId: this.mailboxId, oldValidity: offset.uid_validity, newValidity: uidValidity },
        'UID validity changed - resetting offset'
      );
      await db('email_ingestion_offsets')
        .where({ mailbox_id: this.mailboxId })
        .update({ last_uid: 0, uid_validity: uidValidity, updated_at: new Date() });
      return; // Will fetch from beginning on next poll
    }

    // Fetch batch
    const emails = await this.imapClient.fetchEmailsSinceUid(lastUid, config.batchSize);

    if (emails.length === 0) {
      log.debug({ mailboxId: this.mailboxId, lastUid }, 'No new emails');
      await db('email_ingestion_offsets')
        .where({ mailbox_id: this.mailboxId })
        .update({ last_poll_at: new Date(), updated_at: new Date() });
      return;
    }

    emailsFetched.inc({ mailbox: this.mailboxId }, emails.length);
    log.info({ mailboxId: this.mailboxId, count: emails.length }, 'Fetched emails batch');

    let maxUid = lastUid;

    for (const email of emails) {
      if (!this.running) break;

      try {
        const correlationId = uuidv4();
        const childLog = log.child({ correlationId, uid: email.uid });

        // Quick parse for dedup metadata
        const parsed = await parseEmail(email.rawSource);

        const dedupKey = generateDedupKey({
          mailboxId: this.mailboxId,
          uid: email.uid,
          messageId: parsed.messageId,
          senderNormalized: parsed.senderNormalized,
          subjectNormalized: parsed.subjectNormalized,
          emailDate: parsed.date,
          contentHash: parsed.contentHash,
        });

        // Try to insert (race-condition safe)
        const emailId = uuidv4();
        const inserted = await tryInsertDedupRecord({
          id: emailId,
          mailboxId: this.mailboxId,
          uid: email.uid,
          messageId: parsed.messageId,
          dedupKey,
          contentHash: parsed.contentHash,
          senderNormalized: parsed.senderNormalized,
          subjectNormalized: parsed.subjectNormalized,
          emailDate: parsed.date,
          correlationId,
        });

        if (!inserted) {
          childLog.debug('Duplicate email skipped during ingestion');
          maxUid = Math.max(maxUid, email.uid);
          continue;
        }

        // Enqueue for processing
        const jobData: EmailJobData = {
          emailId,
          mailboxId: this.mailboxId,
          uid: email.uid,
          correlationId,
          rawSource: email.rawSource.toString('base64'),
          attempt: 1,
        };

        await enqueueEmail(jobData);

        // Update status to queued
        await db('ingested_emails')
          .where({ id: emailId })
          .update({ status: 'queued', queued_at: new Date(), updated_at: new Date() });

        emailsQueued.inc({ mailbox: this.mailboxId });
        childLog.info('Email ingested and queued');

        // Mark as read if configured
        if (config.markAsReadOn === 'queued') {
          await this.imapClient.markAsRead(email.uid);
        }

        maxUid = Math.max(maxUid, email.uid);
      } catch (error: any) {
        log.error(
          { uid: email.uid, error: error.message, mailboxId: this.mailboxId },
          'Failed to process email during ingestion'
        );
        // Continue with next email - don't block the batch
        maxUid = Math.max(maxUid, email.uid);
      }
    }

    // Update offset
    if (maxUid > lastUid) {
      await db('email_ingestion_offsets')
        .where({ mailbox_id: this.mailboxId })
        .update({
          last_uid: maxUid,
          uid_validity: uidValidity,
          last_poll_at: new Date(),
          updated_at: new Date(),
        });
      log.info({ mailboxId: this.mailboxId, newOffset: maxUid }, 'Offset updated');
    }
  }
}
