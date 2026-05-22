export enum ErrorType {
  IMAP_CONNECTION = 'IMAP_CONNECTION',
  IMAP_AUTH = 'IMAP_AUTH',
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  MALFORMED_EMAIL = 'MALFORMED_EMAIL',
  DATABASE = 'DATABASE',
  QUEUE_PUBLISH = 'QUEUE_PUBLISH',
  ATTACHMENT_PROCESSING = 'ATTACHMENT_PROCESSING',
  ATTACHMENT_TOO_LARGE = 'ATTACHMENT_TOO_LARGE',
  ATTACHMENT_DISALLOWED_TYPE = 'ATTACHMENT_DISALLOWED_TYPE',
  DOWNSTREAM_PROCESSING = 'DOWNSTREAM_PROCESSING',
  UNKNOWN = 'UNKNOWN',
}

export class IngestionError extends Error {
  public readonly type: ErrorType;
  public readonly retryable: boolean;
  public readonly context: Record<string, unknown>;

  constructor(
    message: string,
    type: ErrorType,
    retryable: boolean = true,
    context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'IngestionError';
    this.type = type;
    this.retryable = retryable;
    this.context = context;
  }
}

export class ImapConnectionError extends IngestionError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, ErrorType.IMAP_CONNECTION, true, context);
    this.name = 'ImapConnectionError';
  }
}

export class ImapAuthError extends IngestionError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, ErrorType.IMAP_AUTH, false, context);
    this.name = 'ImapAuthError';
  }
}

export class MalformedEmailError extends IngestionError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, ErrorType.MALFORMED_EMAIL, false, context);
    this.name = 'MalformedEmailError';
  }
}

export class DatabaseError extends IngestionError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, ErrorType.DATABASE, true, context);
    this.name = 'DatabaseError';
  }
}

export class QueuePublishError extends IngestionError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, ErrorType.QUEUE_PUBLISH, true, context);
    this.name = 'QueuePublishError';
  }
}

export class AttachmentError extends IngestionError {
  constructor(message: string, type: ErrorType, context: Record<string, unknown> = {}) {
    super(message, type, false, context);
    this.name = 'AttachmentError';
  }
}
