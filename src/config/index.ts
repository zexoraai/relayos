import dotenv from 'dotenv';
dotenv.config();

export interface ImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  mailbox: string;
  pollingIntervalMs: number;
  secure: boolean;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string | undefined;
}

export interface QueueConfig {
  name: string;
  concurrency: number;
}

export interface AttachmentConfig {
  maxSizeBytes: number;
  allowedMimeTypes: string[];
  storagePath: string;
}

export interface RetryConfig {
  maxRetryCount: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface Config {
  imap: ImapConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  queue: QueueConfig;
  attachment: AttachmentConfig;
  retry: RetryConfig;
  batchSize: number;
  markAsReadOn: 'queued' | 'processed' | 'never';
  deleteFromMailbox: boolean;
  logLevel: string;
  metricsPort: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function loadConfig(): Config {
  const imapHost = process.env.IMAP_HOST;
  const imapEnabled = !!imapHost;
  return {
    imap: {
      host: imapHost || '',
      port: parseInt(optionalEnv('IMAP_PORT', '993')),
      username: process.env.IMAP_USERNAME || '',
      password: process.env.IMAP_PASSWORD || '',
      mailbox: optionalEnv('IMAP_MAILBOX', 'INBOX'),
      pollingIntervalMs: parseInt(optionalEnv('IMAP_POLLING_INTERVAL_MS', '30000')),
      secure: true,
    },
    database: {
      host: optionalEnv('DATABASE_HOST', 'localhost'),
      port: parseInt(optionalEnv('DATABASE_PORT', '5432')),
      database: optionalEnv('DATABASE_NAME', 'email_ingestion'),
      user: optionalEnv('DATABASE_USER', 'postgres'),
      password: optionalEnv('DATABASE_PASSWORD', 'postgres'),
    },
    redis: {
      host: optionalEnv('REDIS_HOST', 'localhost'),
      port: parseInt(optionalEnv('REDIS_PORT', '6379')),
      password: process.env.REDIS_PASSWORD || undefined,
    },
    queue: {
      name: optionalEnv('QUEUE_NAME', 'email-processing'),
      concurrency: parseInt(optionalEnv('QUEUE_CONCURRENCY', '5')),
    },
    attachment: {
      maxSizeBytes: parseInt(optionalEnv('MAX_ATTACHMENT_SIZE_BYTES', '26214400')),
      allowedMimeTypes: optionalEnv(
        'ALLOWED_MIME_TYPES',
        'application/pdf,image/png,image/jpeg,image/gif,text/plain'
      ).split(','),
      storagePath: optionalEnv('STORAGE_PATH', './storage/attachments'),
    },
    retry: {
      maxRetryCount: parseInt(optionalEnv('MAX_RETRY_COUNT', '5')),
      backoffBaseMs: parseInt(optionalEnv('RETRY_BACKOFF_BASE_MS', '1000')),
      backoffMaxMs: parseInt(optionalEnv('RETRY_BACKOFF_MAX_MS', '60000')),
    },
    batchSize: parseInt(optionalEnv('BATCH_SIZE', '50')),
    markAsReadOn: optionalEnv('MARK_AS_READ_ON', 'processed') as Config['markAsReadOn'],
    deleteFromMailbox: optionalEnv('DELETE_FROM_MAILBOX', 'false') === 'true',
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    metricsPort: parseInt(optionalEnv('METRICS_PORT', '9090')),
  };
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

// For backward compatibility - lazy getter
export const config = new Proxy({} as Config, {
  get(_target, prop) {
    return getConfig()[prop as keyof Config];
  },
});
