import { ImapFlow, FetchMessageObject } from 'imapflow';
import { config, ImapConfig } from '../config';
import { createChildLogger } from '../observability/logger';
import { imapConnectionFailures } from '../observability/metrics';
import { ImapConnectionError, ImapAuthError } from '../errors';

const log = createChildLogger({ module: 'imap' });

export interface FetchedEmail {
  uid: number;
  rawSource: Buffer;
  flags: Set<string>;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private connected = false;
  private mailboxId: string;
  private imapConfig: ImapConfig;

  constructor(mailboxId: string, imapConfig?: ImapConfig) {
    this.mailboxId = mailboxId;
    this.imapConfig = imapConfig || config.imap;
  }

  async connect(): Promise<void> {
    try {
      this.client = new ImapFlow({
        host: this.imapConfig.host,
        port: this.imapConfig.port,
        secure: this.imapConfig.secure,
        auth: {
          user: this.imapConfig.username,
          pass: this.imapConfig.password,
        },
        logger: false,
        emitLogs: false,
      });

      this.client.on('error', (err: Error) => {
        log.error({ error: err.message, mailboxId: this.mailboxId }, 'IMAP client error');
        this.connected = false;
        imapConnectionFailures.inc({ mailbox: this.mailboxId });
      });

      this.client.on('close', () => {
        log.info({ mailboxId: this.mailboxId }, 'IMAP connection closed');
        this.connected = false;
      });

      await this.client.connect();
      this.connected = true;
      log.info({ mailboxId: this.mailboxId, host: this.imapConfig.host }, 'IMAP connected');
    } catch (error: any) {
      imapConnectionFailures.inc({ mailbox: this.mailboxId });

      if (error.authenticationFailed || error.message?.includes('auth')) {
        throw new ImapAuthError(`Authentication failed for ${this.imapConfig.username}`, {
          host: this.imapConfig.host,
        });
      }

      throw new ImapConnectionError(`Failed to connect to IMAP: ${error.message}`, {
        host: this.imapConfig.host,
        port: this.imapConfig.port,
      });
    }
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected || !this.client) {
      log.info({ mailboxId: this.mailboxId }, 'Reconnecting to IMAP');
      await this.connect();
    }
  }

  async getUidValidity(): Promise<number | null> {
    await this.ensureConnected();
    const lock = await this.client!.getMailboxLock(this.imapConfig.mailbox);
    try {
      const mailbox = this.client!.mailbox;
      if (mailbox && typeof mailbox === 'object' && 'uidValidity' in mailbox) {
        return (mailbox as any).uidValidity || null;
      }
      return null;
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch emails by UID range in batches.
   * Returns emails with UID > lastUid, limited by batchSize.
   */
  async fetchEmailsSinceUid(lastUid: number, batchSize: number): Promise<FetchedEmail[]> {
    await this.ensureConnected();

    const lock = await this.client!.getMailboxLock(this.imapConfig.mailbox);
    const emails: FetchedEmail[] = [];

    try {
      const range = `${lastUid + 1}:*`;

      let count = 0;
      for await (const message of this.client!.fetch(range, {
        uid: true,
        source: true,
        flags: true,
      }, { uid: true })) {
        if (count >= batchSize) break;

        if (message.uid <= lastUid) continue;

        emails.push({
          uid: message.uid,
          rawSource: message.source!,
          flags: message.flags || new Set<string>(),
        });
        count++;
      }

      log.info(
        { mailboxId: this.mailboxId, lastUid, fetched: emails.length },
        'Emails fetched from IMAP'
      );

      return emails;
    } finally {
      lock.release();
    }
  }

  /**
   * Mark an email as read (\\Seen flag).
   */
  async markAsRead(uid: number): Promise<void> {
    await this.ensureConnected();
    const lock = await this.client!.getMailboxLock(this.imapConfig.mailbox);
    try {
      await this.client!.messageFlagsAdd({ uid: uid } as any, ['\\Seen'], { uid: true });
      log.debug({ uid, mailboxId: this.mailboxId }, 'Email marked as read');
    } finally {
      lock.release();
    }
  }

  /**
   * Delete an email from the mailbox.
   */
  async deleteEmail(uid: number): Promise<void> {
    await this.ensureConnected();
    const lock = await this.client!.getMailboxLock(this.imapConfig.mailbox);
    try {
      await this.client!.messageDelete({ uid: uid } as any, { uid: true });
      log.debug({ uid, mailboxId: this.mailboxId }, 'Email deleted from mailbox');
    } finally {
      lock.release();
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout();
      this.connected = false;
      this.client = null;
      log.info({ mailboxId: this.mailboxId }, 'IMAP disconnected');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
