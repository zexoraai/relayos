import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load config from environment variables', async () => {
    process.env.IMAP_HOST = 'test.imap.com';
    process.env.IMAP_PORT = '993';
    process.env.IMAP_USERNAME = 'testuser';
    process.env.IMAP_PASSWORD = 'testpass';
    process.env.IMAP_MAILBOX = 'INBOX';
    process.env.BATCH_SIZE = '100';
    process.env.MAX_RETRY_COUNT = '3';

    // Re-import to get fresh config
    const { loadConfig } = await import('../src/config');
    const config = loadConfig();

    expect(config.imap.host).toBe('test.imap.com');
    expect(config.imap.port).toBe(993);
    expect(config.imap.username).toBe('testuser');
    expect(config.imap.mailbox).toBe('INBOX');
    expect(config.batchSize).toBe(100);
    expect(config.retry.maxRetryCount).toBe(3);
  });

  it('should use default values for optional settings', async () => {
    process.env.IMAP_HOST = 'test.imap.com';
    process.env.IMAP_USERNAME = 'testuser';
    process.env.IMAP_PASSWORD = 'testpass';

    const { loadConfig } = await import('../src/config');
    const config = loadConfig();

    expect(config.imap.port).toBe(993);
    expect(config.imap.mailbox).toBe('INBOX');
    expect(config.imap.pollingIntervalMs).toBe(30000);
    expect(config.batchSize).toBe(50);
    expect(config.retry.maxRetryCount).toBe(5);
    expect(config.retry.backoffBaseMs).toBe(1000);
    expect(config.retry.backoffMaxMs).toBe(60000);
    expect(config.attachment.maxSizeBytes).toBe(26214400);
    expect(config.markAsReadOn).toBe('processed');
    expect(config.deleteFromMailbox).toBe(false);
  });

  it('should throw on missing required variables', async () => {
    delete process.env.IMAP_HOST;
    delete process.env.IMAP_USERNAME;
    delete process.env.IMAP_PASSWORD;

    const { loadConfig } = await import('../src/config');
    expect(() => loadConfig()).toThrow('Missing required environment variable');
  });

  it('should parse allowed MIME types as array', async () => {
    process.env.IMAP_HOST = 'test.imap.com';
    process.env.IMAP_USERNAME = 'testuser';
    process.env.IMAP_PASSWORD = 'testpass';
    process.env.ALLOWED_MIME_TYPES = 'application/pdf,image/png,text/plain';

    const { loadConfig } = await import('../src/config');
    const config = loadConfig();

    expect(config.attachment.allowedMimeTypes).toEqual([
      'application/pdf',
      'image/png',
      'text/plain',
    ]);
  });

  it('should parse mark-as-read behavior', async () => {
    process.env.IMAP_HOST = 'test.imap.com';
    process.env.IMAP_USERNAME = 'testuser';
    process.env.IMAP_PASSWORD = 'testpass';
    process.env.MARK_AS_READ_ON = 'queued';

    const { loadConfig } = await import('../src/config');
    const config = loadConfig();

    expect(config.markAsReadOn).toBe('queued');
  });
});
