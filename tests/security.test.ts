import { describe, it, expect } from 'vitest';
import { sanitizeFilename, validateStoragePath } from '../src/security';

describe('Security', () => {
  describe('sanitizeFilename', () => {
    it('should return sanitized filename', () => {
      expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
    });

    it('should remove path traversal characters', () => {
      const result = sanitizeFilename('../../../etc/passwd');
      expect(result).not.toContain('..');
      expect(result).not.toContain('/');
    });

    it('should handle null filename', () => {
      expect(sanitizeFilename(null)).toBe('unnamed_attachment');
    });

    it('should handle empty filename', () => {
      expect(sanitizeFilename('')).toBe('unnamed_attachment');
    });

    it('should remove directory components', () => {
      const result = sanitizeFilename('/path/to/file.txt');
      expect(result).toBe('file.txt');
    });

    it('should handle Windows path separators', () => {
      const result = sanitizeFilename('C:\\Users\\test\\file.txt');
      expect(result).not.toContain('\\');
    });

    it('should handle special characters', () => {
      const result = sanitizeFilename('file<>:"|?*.txt');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).not.toContain(':');
    });

    it('should truncate very long filenames', () => {
      const longName = 'a'.repeat(300) + '.pdf';
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
      expect(result.endsWith('.pdf')).toBe(true);
    });
  });

  describe('validateStoragePath', () => {
    it('should allow valid paths within base directory', () => {
      const result = validateStoragePath('/storage', 'emails/123/file.pdf');
      expect(result).toContain('emails');
      expect(result).toContain('file.pdf');
    });

    it('should reject path traversal attempts', () => {
      expect(() => {
        validateStoragePath('/storage', '../../etc/passwd');
      }).toThrow('Path traversal detected');
    });

    it('should reject absolute paths that escape base', () => {
      expect(() => {
        validateStoragePath('/storage/attachments', '../../../tmp/evil');
      }).toThrow('Path traversal detected');
    });
  });
});
