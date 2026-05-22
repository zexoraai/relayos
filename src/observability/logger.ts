import pino from 'pino';

function getLogLevel(): string {
  return process.env.LOG_LEVEL || 'info';
}

export const logger = pino({
  level: getLogLevel(),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['password', 'imap.password', 'config.imap.password', 'config.database.password', 'config.redis.password'],
    censor: '[REDACTED]',
  },
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
