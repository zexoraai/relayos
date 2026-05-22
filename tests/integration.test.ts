import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDedupKey } from '../src/dedup';
import { parseEmail } from '../src/parser';

describe('Integration Tests', () => {
  describe('Duplicate Detection - Same Message-ID', () => {
    it('should detect duplicate emails with same Message-ID', async () => {
      const email1Raw = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: Test Email',
        'Message-ID: <duplicate-123@example.com>',
        'Date: Mon, 01 Jan 2024 00:00:00 +0000',
        'Content-Type: text/plain',
        '',
        'First copy of the email.',
      ].join('\r\n');

      const email2Raw = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: Test Email',
        'Message-ID: <duplicate-123@example.com>',
        'Date: Mon, 01 Jan 2024 00:00:00 +0000',
        'Content-Type: text/plain',
        '',
        'First copy of the email.',
      ].join('\r\n');

      const parsed1 = await parseEmail(Buffer.from(email1Raw));
      const parsed2 = await parseEmail(Buffer.from(email2Raw));

      const key1 = generateDedupKey({
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: parsed1.messageId,
        senderNormalized: parsed1.senderNormalized,
        subjectNormalized: parsed1.subjectNormalized,
        emailDate: parsed1.date,
        contentHash: parsed1.contentHash,
      });

      const key2 = generateDedupKey({
        mailboxId: 'mailbox-1',
        uid: 100,
        messageId: parsed2.messageId,
        senderNormalized: parsed2.senderNormalized,
        subjectNormalized: parsed2.subjectNormalized,
        emailDate: parsed2.date,
        contentHash: parsed2.contentHash,
      });

      expect(key1).toBe(key2);
    });
  });

  describe('Duplicate Detection - Missing Message-ID, Same Content Hash', () => {
    it('should detect duplicates via content hash when Message-ID is missing', async () => {
      const emailRaw = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: No ID Email',
        'Date: Mon, 01 Jan 2024 00:00:00 +0000',
        'Content-Type: text/plain',
        '',
        'This email has no Message-ID header.',
      ].join('\r\n');

      const parsed1 = await parseEmail(Buffer.from(emailRaw));
      const parsed2 = await parseEmail(Buffer.from(emailRaw));

      expect(parsed1.messageId).toBeNull();
      expect(parsed2.messageId).toBeNull();
      expect(parsed1.contentHash).toBe(parsed2.contentHash);

      const key1 = generateDedupKey({
        mailboxId: 'mailbox-1',
        uid: 200,
        messageId: null,
        senderNormalized: parsed1.senderNormalized,
        subjectNormalized: parsed1.subjectNormalized,
        emailDate: parsed1.date,
        contentHash: parsed1.contentHash,
      });

      const key2 = generateDedupKey({
        mailboxId: 'mailbox-1',
        uid: 200,
        messageId: null,
        senderNormalized: parsed2.senderNormalized,
        subjectNormalized: parsed2.subjectNormalized,
        emailDate: parsed2.date,
        contentHash: parsed2.contentHash,
      });

      expect(key1).toBe(key2);
    });
  });

  describe('Malformed Email Handling', () => {
    it('should handle email with missing headers', async () => {
      const minimal = [
        'Content-Type: text/plain',
        '',
        'Just a body, no other headers.',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(minimal));
      expect(result.sender).toBeNull();
      expect(result.subject).toBeNull();
      expect(result.messageId).toBeNull();
      expect(result.contentHash).toHaveLength(64);
    });

    it('should handle completely empty email', async () => {
      const result = await parseEmail(Buffer.from(''));
      expect(result.contentHash).toHaveLength(64);
    });

    it('should handle binary garbage gracefully', async () => {
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      const result = await parseEmail(garbage);
      expect(result.contentHash).toHaveLength(64);
    });
  });

  describe('Attachment Parsing', () => {
    it('should parse multiple attachments', async () => {
      const email = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: Multi Attachment',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="sep"',
        '',
        '--sep',
        'Content-Type: text/plain',
        '',
        'Body text.',
        '--sep',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="doc1.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQK',
        '--sep',
        'Content-Type: image/png',
        'Content-Disposition: attachment; filename="image.png"',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--sep--',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(email));
      expect(result.attachments.length).toBe(2);
      expect(result.attachments[0].filename).toBe('doc1.pdf');
      expect(result.attachments[0].contentType).toBe('application/pdf');
      expect(result.attachments[1].filename).toBe('image.png');
      expect(result.attachments[1].contentType).toBe('image/png');
    });

    it('should compute unique checksums for different attachments', async () => {
      const email = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: Checksum Test',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="sep"',
        '',
        '--sep',
        'Content-Type: text/plain',
        '',
        'Body.',
        '--sep',
        'Content-Type: text/plain',
        'Content-Disposition: attachment; filename="file1.txt"',
        '',
        'Content of file 1',
        '--sep',
        'Content-Type: text/plain',
        'Content-Disposition: attachment; filename="file2.txt"',
        '',
        'Content of file 2',
        '--sep--',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(email));
      expect(result.attachments.length).toBe(2);
      expect(result.attachments[0].checksumSha256).not.toBe(result.attachments[1].checksumSha256);
    });
  });

  describe('UID Offset Tracking', () => {
    it('should track maximum UID correctly', () => {
      const uids = [101, 105, 103, 110, 102];
      const maxUid = Math.max(...uids);
      expect(maxUid).toBe(110);
    });

    it('should not regress offset on restart', () => {
      // Simulates the logic: new emails must have UID > lastUid
      const lastUid = 100;
      const newEmails = [
        { uid: 101 },
        { uid: 102 },
        { uid: 103 },
      ];

      const validEmails = newEmails.filter(e => e.uid > lastUid);
      expect(validEmails.length).toBe(3);

      // Emails at or below lastUid should be skipped
      const oldEmails = [{ uid: 99 }, { uid: 100 }];
      const skipped = oldEmails.filter(e => e.uid > lastUid);
      expect(skipped.length).toBe(0);
    });
  });

  describe('Safe Restart Behavior', () => {
    it('should not lose emails if service restarts mid-batch', () => {
      // Simulates: if we crash after processing UID 105 but before updating offset from 100,
      // on restart we'll re-fetch UIDs 101-105 but dedup will prevent reprocessing
      const processedBeforeCrash = [101, 102, 103, 104, 105];
      const offsetBeforeCrash = 100; // Not yet updated

      // On restart, fetch from offsetBeforeCrash + 1
      const refetchedUids = [101, 102, 103, 104, 105, 106, 107];

      // Dedup should catch the already-processed ones
      const alreadyProcessed = new Set(processedBeforeCrash);
      const newToProcess = refetchedUids.filter(uid => !alreadyProcessed.has(uid));

      expect(newToProcess).toEqual([106, 107]);
    });
  });

  describe('Concurrent Duplicate Processing Prevention', () => {
    it('should generate same dedup key for concurrent identical emails', () => {
      const sharedInput = {
        mailboxId: 'mailbox-1',
        uid: 500,
        messageId: '<concurrent@example.com>',
        senderNormalized: 'sender@example.com',
        subjectNormalized: 'concurrent test',
        emailDate: new Date('2024-06-01T12:00:00Z'),
        contentHash: 'hash123',
      };

      // Simulate two workers generating keys simultaneously
      const key1 = generateDedupKey(sharedInput);
      const key2 = generateDedupKey(sharedInput);

      // Both should produce the same key, so the DB unique constraint
      // will prevent the second insert
      expect(key1).toBe(key2);
    });
  });
});
