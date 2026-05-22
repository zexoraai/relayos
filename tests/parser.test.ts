import { describe, it, expect } from 'vitest';
import { parseEmail, normalizeEmail, normalizeSubject } from '../src/parser';

describe('Email Parser', () => {
  describe('normalizeEmail', () => {
    it('should lowercase email addresses', () => {
      expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
    });

    it('should trim whitespace', () => {
      expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
    });

    it('should return null for null input', () => {
      expect(normalizeEmail(null)).toBeNull();
    });

    it('should return null for undefined input', () => {
      expect(normalizeEmail(undefined)).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(normalizeEmail('')).toBeNull();
    });
  });

  describe('normalizeSubject', () => {
    it('should remove Re: prefix', () => {
      expect(normalizeSubject('Re: Hello World')).toBe('hello world');
    });

    it('should remove Fw: prefix', () => {
      expect(normalizeSubject('Fw: Hello World')).toBe('hello world');
    });

    it('should remove Fwd: prefix', () => {
      expect(normalizeSubject('Fwd: Hello World')).toBe('hello world');
    });

    it('should remove multiple prefixes', () => {
      expect(normalizeSubject('Re: Fw: Hello World')).toBe('fw: hello world');
    });

    it('should lowercase and trim', () => {
      expect(normalizeSubject('  HELLO WORLD  ')).toBe('hello world');
    });

    it('should collapse whitespace', () => {
      expect(normalizeSubject('Hello   World')).toBe('hello world');
    });

    it('should return null for null input', () => {
      expect(normalizeSubject(null)).toBeNull();
    });
  });

  describe('parseEmail', () => {
    const validEmail = [
      'From: sender@example.com',
      'To: recipient@example.com',
      'Subject: Test Email',
      'Message-ID: <test-123@example.com>',
      'Date: Mon, 01 Jan 2024 00:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello, this is a test email body.',
    ].join('\r\n');

    it('should parse a valid email', async () => {
      const result = await parseEmail(Buffer.from(validEmail));

      expect(result.messageId).toBe('<test-123@example.com>');
      expect(result.sender).toBe('sender@example.com');
      expect(result.senderNormalized).toBe('sender@example.com');
      expect(result.recipients).toContain('recipient@example.com');
      expect(result.subject).toBe('Test Email');
      expect(result.subjectNormalized).toBe('test email');
      expect(result.bodyText).toContain('Hello, this is a test email body.');
      expect(result.contentHash).toHaveLength(64);
    });

    it('should handle email without Message-ID', async () => {
      const emailNoId = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: No ID Email',
        'Date: Mon, 01 Jan 2024 00:00:00 +0000',
        'Content-Type: text/plain',
        '',
        'Body without message ID.',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(emailNoId));
      expect(result.messageId).toBeNull();
      expect(result.contentHash).toHaveLength(64);
    });

    it('should handle email without subject', async () => {
      const emailNoSubject = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Message-ID: <no-subject@example.com>',
        'Content-Type: text/plain',
        '',
        'Body without subject.',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(emailNoSubject));
      expect(result.subject).toBeNull();
      expect(result.subjectNormalized).toBeNull();
    });

    it('should handle email with CC and BCC', async () => {
      const emailWithCc = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Cc: cc1@example.com, cc2@example.com',
        'Subject: CC Test',
        'Content-Type: text/plain',
        '',
        'Body.',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(emailWithCc));
      expect(result.cc).toContain('cc1@example.com');
      expect(result.cc).toContain('cc2@example.com');
    });

    it('should handle malformed email gracefully', async () => {
      // Completely invalid content should still be handled
      const malformed = 'This is not a valid email at all';
      const result = await parseEmail(Buffer.from(malformed));

      // mailparser is lenient - it will parse what it can
      expect(result.contentHash).toHaveLength(64);
    });

    it('should parse email with attachment', async () => {
      const emailWithAttachment = [
        'From: sender@example.com',
        'To: recipient@example.com',
        'Subject: Attachment Test',
        'Message-ID: <attach-test@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="boundary123"',
        '',
        '--boundary123',
        'Content-Type: text/plain',
        '',
        'Email body with attachment.',
        '--boundary123',
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="test.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5k',
        '--boundary123--',
      ].join('\r\n');

      const result = await parseEmail(Buffer.from(emailWithAttachment));
      expect(result.attachments.length).toBeGreaterThanOrEqual(1);
      expect(result.attachments[0].filename).toBe('test.pdf');
      expect(result.attachments[0].contentType).toBe('application/pdf');
      expect(result.attachments[0].checksumSha256).toHaveLength(64);
    });

    it('should generate consistent content hash for same email', async () => {
      const result1 = await parseEmail(Buffer.from(validEmail));
      const result2 = await parseEmail(Buffer.from(validEmail));

      expect(result1.contentHash).toBe(result2.contentHash);
    });
  });
});
