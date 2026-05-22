import { describe, it, expect, beforeEach } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth';
import { encrypt, decrypt } from '../src/crypto';

describe('Auth', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-key';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok';
  });

  describe('Password Hashing', () => {
    it('should hash a password', async () => {
      const hash = await hashPassword('mypassword123');
      expect(hash).not.toBe('mypassword123');
      expect(hash.length).toBeGreaterThan(50);
    });

    it('should verify correct password', async () => {
      const hash = await hashPassword('mypassword123');
      const valid = await verifyPassword('mypassword123', hash);
      expect(valid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const hash = await hashPassword('mypassword123');
      const valid = await verifyPassword('wrongpassword', hash);
      expect(valid).toBe(false);
    });

    it('should produce different hashes for same password', async () => {
      const hash1 = await hashPassword('mypassword123');
      const hash2 = await hashPassword('mypassword123');
      expect(hash1).not.toBe(hash2); // bcrypt uses random salt
    });
  });

  describe('Encryption', () => {
    it('should encrypt and decrypt a string', () => {
      const plaintext = 'my-secret-imap-password';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.length).toBeGreaterThan(0);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext', () => {
      const plaintext = 'same-password';
      const enc1 = encrypt(plaintext);
      const enc2 = encrypt(plaintext);
      expect(enc1).not.toBe(enc2); // random IV
    });

    it('should handle empty string', () => {
      const encrypted = encrypt('');
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('should handle special characters', () => {
      const plaintext = 'p@$$w0rd!#%^&*()_+{}|:<>?';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should not store plaintext in encrypted output', () => {
      const plaintext = 'visible-secret-password';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toContain(plaintext);
    });
  });
});
