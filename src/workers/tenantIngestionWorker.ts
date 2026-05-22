import { v4 as uuidv4 } from 'uuid';
import { ImapClient } from '../imap';
import { parseEmail } from '../parser';
import { generateDedupKey, tryInsertDedupRecord } from '../dedup';
import { enqueueEmail, EmailJobData } from '../queue';
import { getDb } from '../db/connection';
import { config, ImapConfig } from '../config';
import { createChildLogger } from '../observability/logger';
import { emailsFetched, emailsQueued } from '../observability/metrics';
import { IngestionError, ErrorType } from '../errors';
import { getActiveImapIngestionConfigs, TenantImapConfig } from '../tenants';

const log = createChildLogger({ module: 'tenant-ingestion-worker' });

/**
 * Per-tenant IMAP polling worker.
 *
 * On each tick:
 *   - Loads every active tenant_imap_settings row (joined to active tenants)
 *   - For each, ensures a mailboxes row exists (host+username keyed)
 *   - Connects via ImapClient, fetches new emails since last UID, enqueues them
 *   - Reuses ImapClient instances across ticks (one per tenant) so we keep the
 *     IMAP connection warm
 *
 * Runs in addition to the legacy env-based IngestionWorker — if both are configured
 * for the same host/username, the existing dedup logic in mailboxes makes that safe.
 */
export class TenantIngestionWorker {
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private clients = new Map<string, { client: ImapClient; mailboxId: string; lastUsername: string }>();

  async start(): Promise<void> {
    this.running = true;
    log.info('Tenant ingestion worker starting');
    await this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const entry of this.clients.values()) {
      try {
        await entry.client.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    log.info('Tenant ingestion worker stopped');
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    let configs: TenantImapConfig[] = [];
    try {
      configs = await getActiveImapIngestionConfigs();
    } catch (error: any) {
      log.error({ error: error.message }, 'Failed to load tenant IMAP configs');
    }

    if (configs.length === 0) {
      log.debug('No active tenant IMAP configs');
    }

    const activeIds = new Set(configs.map((c) => c.tenant_id));
    for (const [tenantId, entry] of this.clients.entries()) {
      if (!activeIds.has(tenantId)) {
        try {
          await entry.client.disconnect();
        } catch {
          /* ignore */
        }
        this.clients.delete(tenantId);
        log.info({ tenantId }, 'Removed cached IMAP client (tenant no longer active)');
      }
    }

    await Promise.allSettled(configs.map((cfg) => this.runOneTenant(cfg)));

    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), config.imap.pollingIntervalMs || 30000);
    }
  }

  private async runOneTenant(cfg: TenantImapConfig): Promise<void> {
    const ctx = { tenantId: cfg.tenant_id, host: cfg.imap_host, user: cfg.imap_username };
    const db = getDb();

    // 1. Ensure mailboxes row exists
    const existing = await db('mailboxes')
      .where({ host: cfg.imap_host, username: cfg.imap_username, mailbox_folder: cfg.imap_mailbox })
      .first();
    let mailboxId: string;
    if (existing) {
      mailboxId = existing.id;
      const offset = await db('email_ingestion_offsets').where({ mailbox_id: mailboxId }).first();
      if (!offset) {
        await db('email_ingestion_offsets').insert({ mailbox_id: mailboxId, last_uid: 0 });
      }
    } else {
      mailboxId = uuidv4();
      await db('mailboxes').insert({
        id: mailboxId,
        host: cfg.imap_host,
        port: cfg.imap_port,
        username: cfg.imap_username,
        mailbox_folder: cfg.imap_mailbox,
        is_active: true,
      });
      await db('email_ingestion_offsets').insert({ mailbox_id: mailboxId, last_uid: 0 });
    }

    // 2. Reuse or build a client for this tenant
    const cached = this.clients.get(cfg.tenant_id);
    let client: ImapClient;
    if (cached && cached.lastUsername === cfg.imap_username && cached.mailboxId === mailboxId) {
      client = cached.client;
    } else {
      if (cached) {
        try {
          await cached.client.disconnect();
        } catch {
          /* ignore */
        }
      }
      const tenantImapConfig: ImapConfig = {
        host: cfg.imap_host,
        port: cfg.imap_port,
        username: cfg.imap_username,
        password: cfg.imap_password,
        mailbox: cfg.imap_mailbox,
        pollingIntervalMs: config.imap.pollingIntervalMs,
        secure: true,
      };
      client = new ImapClient(mailboxId, tenantImapConfig);
      this.clients.set(cfg.tenant_id, { client, mailboxId, lastUsername: cfg.imap_username });
    }

    // 3. Fetch + enqueue (ImapClient methods call ensureConnected() internally)
    try {
      await this.fetchAndEnqueue(client, mailboxId, ctx);
    } catch (error: any) {
      log.error({ ...ctx, error: error.message }, 'Tenant ingestion poll failed');
      if (error instanceof IngestionError && error.type === ErrorType.IMAP_CONNECTION) {
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
        this.clients.delete(cfg.tenant_id);
      }
    }
  }

  private async fetchAndEnqueue(
    client: ImapClient,
    mailboxId: string,
    ctx: { tenantId: string; host: string; user: string },
  ): Promise<void> {
    const db = getDb();

    const offset = await db('email_ingestion_offsets').where({ mailbox_id: mailboxId }).first();
    const lastUid = Number(offset?.last_uid) || 0;

    const uidValidity = await client.getUidValidity();
    if (offset?.uid_validity && uidValidity && Number(offset.uid_validity) !== Number(uidValidity)) {
      log.warn({ ...ctx, oldValidity: offset.uid_validity, newValidity: uidValidity }, 'UID validity changed - resetting offset');
      await db('email_ingestion_offsets')
        .where({ mailbox_id: mailboxId })
        .update({ last_uid: 0, uid_validity: uidValidity, updated_at: new Date() });
      return;
    }

    const emails = await client.fetchEmailsSinceUid(lastUid, config.batchSize);
    if (emails.length === 0) {
      await db('email_ingestion_offsets')
        .where({ mailbox_id: mailboxId })
        .update({ last_poll_at: new Date(), updated_at: new Date() });
      return;
    }

    emailsFetched.inc({ mailbox: mailboxId }, emails.length);
    log.info({ ...ctx, count: emails.length }, 'Fetched emails batch');

    let maxUid = lastUid;
    for (const email of emails) {
      if (!this.running) break;
      try {
        const correlationId = uuidv4();
        const parsed = await parseEmail(email.rawSource);
        const dedupKey = generateDedupKey({
          mailboxId,
          uid: email.uid,
          messageId: parsed.messageId,
          senderNormalized: parsed.senderNormalized,
          subjectNormalized: parsed.subjectNormalized,
          emailDate: parsed.date,
          contentHash: parsed.contentHash,
        });
        const emailId = uuidv4();
        const inserted = await tryInsertDedupRecord({
          id: emailId,
          mailboxId,
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
          log.debug({ ...ctx, correlationId, uid: email.uid }, 'Duplicate email skipped during ingestion');
          maxUid = Math.max(maxUid, email.uid);
          continue;
        }
        const jobData: EmailJobData = {
          emailId,
          mailboxId,
          uid: email.uid,
          correlationId,
          rawSource: email.rawSource.toString('base64'),
          attempt: 1,
        };
        await enqueueEmail(jobData);
        await db('ingested_emails').where({ id: emailId }).update({ status: 'queued', queued_at: new Date(), updated_at: new Date() });
        emailsQueued.inc({ mailbox: mailboxId });
        log.info({ ...ctx, correlationId, uid: email.uid }, 'Email ingested and queued');
        if (config.markAsReadOn === 'queued') {
          await client.markAsRead(email.uid);
        }
        maxUid = Math.max(maxUid, email.uid);
      } catch (error: any) {
        log.error({ ...ctx, uid: email.uid, error: error.message }, 'Failed to process email during ingestion');
        maxUid = Math.max(maxUid, email.uid);
      }
    }

    if (maxUid > lastUid) {
      await db('email_ingestion_offsets')
        .where({ mailbox_id: mailboxId })
        .update({ last_uid: maxUid, uid_validity: uidValidity, last_poll_at: new Date(), updated_at: new Date() });
      log.info({ ...ctx, newOffset: maxUid }, 'Offset updated');
    }
  }
}
