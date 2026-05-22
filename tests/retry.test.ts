import { describe, it, expect } from 'vitest';
import { IngestionError, ErrorType, ImapConnectionError, ImapAuthError, MalformedEmailError } from '../src/errors';

describe('Error Handling and Retry Logic', () => {
  describe('Error Types', () => {
    it('should create retryable IMAP connection error', () => {
      const error = new ImapConnectionError('Connection refused');
      expect(error.type).toBe(ErrorType.IMAP_CONNECTION);
      expect(error.retryable).toBe(true);
      expect(error.message).toBe('Connection refused');
    });

    it('should create non-retryable auth error', () => {
      const error = new ImapAuthError('Invalid credentials');
      expect(error.type).toBe(ErrorType.IMAP_AUTH);
      expect(error.retryable).toBe(false);
    });

    it('should create non-retryable malformed email error', () => {
      const error = new MalformedEmailError('Invalid MIME structure');
      expect(error.type).toBe(ErrorType.MALFORMED_EMAIL);
      expect(error.retryable).toBe(false);
    });

    it('should carry context information', () => {
      const error = new ImapConnectionError('Timeout', { host: 'imap.example.com', port: 993 });
      expect(error.context).toEqual({ host: 'imap.example.com', port: 993 });
    });

    it('should be instanceof Error', () => {
      const error = new IngestionError('test', ErrorType.UNKNOWN, true);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(IngestionError);
    });
  });

  describe('Retry Decision Logic', () => {
    it('should retry on connection errors', () => {
      const error = new ImapConnectionError('ECONNREFUSED');
      expect(error.retryable).toBe(true);
    });

    it('should not retry on auth errors', () => {
      const error = new ImapAuthError('Bad credentials');
      expect(error.retryable).toBe(false);
    });

    it('should not retry on malformed email', () => {
      const error = new MalformedEmailError('Cannot parse');
      expect(error.retryable).toBe(false);
    });

    it('should retry on database errors', () => {
      const error = new IngestionError('Connection pool exhausted', ErrorType.DATABASE, true);
      expect(error.retryable).toBe(true);
    });

    it('should retry on queue publish errors', () => {
      const error = new IngestionError('Redis unavailable', ErrorType.QUEUE_PUBLISH, true);
      expect(error.retryable).toBe(true);
    });
  });

  describe('Exponential Backoff Calculation', () => {
    function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
      const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
      return delay;
    }

    it('should increase delay exponentially', () => {
      const base = 1000;
      const max = 60000;

      expect(calculateBackoff(0, base, max)).toBe(1000);
      expect(calculateBackoff(1, base, max)).toBe(2000);
      expect(calculateBackoff(2, base, max)).toBe(4000);
      expect(calculateBackoff(3, base, max)).toBe(8000);
      expect(calculateBackoff(4, base, max)).toBe(16000);
    });

    it('should cap at maximum delay', () => {
      const base = 1000;
      const max = 60000;

      expect(calculateBackoff(10, base, max)).toBe(60000);
      expect(calculateBackoff(20, base, max)).toBe(60000);
    });
  });
});
