import { describe, it, expect } from 'vitest';
import { generateDedupKey } from '../src/dedup';

describe('Deduplication', () => {
  describe('generateDedupKey', () => {
    it('should generate consistent key for same inputs', () => {
      const input = {
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: '<test@example.com>',
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'test subject',
        emailDate: new Date('2024-01-01T00:00:00Z'),
        contentHash: 'abc123',
      };

      const key1 = generateDedupKey(input);
      const key2 = generateDedupKey(input);

      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // SHA-256 hex
    });

    it('should generate different keys for different UIDs', () => {
      const base = {
        mailboxId: 'mailbox-1',
        messageId: '<test@example.com>',
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'test subject',
        emailDate: new Date('2024-01-01T00:00:00Z'),
        contentHash: 'abc123',
      };

      const key1 = generateDedupKey({ ...base, uid: 100 });
      const key2 = generateDedupKey({ ...base, uid: 101 });

      expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different mailboxes', () => {
      const base = {
        uid: 100,
        messageId: '<test@example.com>',
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'test subject',
        emailDate: new Date('2024-01-01T00:00:00Z'),
        contentHash: 'abc123',
      };

      const key1 = generateDedupKey({ ...base, mailboxId: 'mailbox-1' });
      const key2 = generateDedupKey({ ...base, mailboxId: 'mailbox-2' });

      expect(key1).not.toBe(key2);
    });

    it('should use content hash when Message-ID is missing', () => {
      const input = {
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: null,
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'test subject',
        emailDate: new Date('2024-01-01T00:00:00Z'),
        contentHash: 'abc123',
      };

      const key = generateDedupKey(input);
      expect(key).toHaveLength(64);

      // Different content hash should produce different key
      const key2 = generateDedupKey({ ...input, contentHash: 'def456' });
      expect(key).not.toBe(key2);
    });

    it('should generate different keys when Message-ID differs', () => {
      const base = {
        mailboxId: 'mailbox-1',
        uid: 100,
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'test subject',
        emailDate: new Date('2024-01-01T00:00:00Z'),
        contentHash: 'abc123',
      };

      const key1 = generateDedupKey({ ...base, messageId: '<msg1@example.com>' });
      const key2 = generateDedupKey({ ...base, messageId: '<msg2@example.com>' });

      expect(key1).not.toBe(key2);
    });

    it('should handle null sender and subject gracefully', () => {
      const input = {
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: '<test@example.com>',
        senderNormalized: null,
        subjectNormalized: null,
        emailDate: null,
        contentHash: 'abc123',
      };

      const key = generateDedupKey(input);
      expect(key).toHaveLength(64);
    });

    it('should produce same key for duplicate emails with same Message-ID', () => {
      const email1 = {
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: '<unique-id@example.com>',
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'hello world',
        emailDate: new Date('2024-06-15T10:00:00Z'),
        contentHash: 'hash1',
      };

      const email2 = {
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: '<unique-id@example.com>',
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'hello world',
        emailDate: new Date('2024-06-15T10:00:00Z'),
        contentHash: 'hash1',
      };

      expect(generateDedupKey(email1)).toBe(generateDedupKey(email2));
    });
  });
});
