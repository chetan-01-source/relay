import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sealCredential, openCredential } from './crypto.js';

const masterKey = randomBytes(32).toString('base64');

describe('envelope crypto', () => {
  it('round-trips a provider key (seal -> open)', () => {
    const sealed = sealCredential(masterKey, 'sk-secret-abc123');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('sk-secret'); // not plaintext
    expect(openCredential(masterKey, sealed)).toBe('sk-secret-abc123');
  });

  it('uses a fresh DEK per seal (different ciphertext for same plaintext)', () => {
    const a = sealCredential(masterKey, 'sk-same');
    const b = sealCredential(masterKey, 'sk-same');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(openCredential(masterKey, a)).toBe('sk-same');
    expect(openCredential(masterKey, b)).toBe('sk-same');
  });

  it('fails to open when the ciphertext is tampered (GCM auth tag)', () => {
    const sealed = sealCredential(masterKey, 'sk-tamper');
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => openCredential(masterKey, sealed)).toThrow();
  });

  it('fails to open under the wrong master key', () => {
    const sealed = sealCredential(masterKey, 'sk-x');
    const wrong = randomBytes(32).toString('base64');
    expect(() => openCredential(wrong, sealed)).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => sealCredential(Buffer.from('short').toString('base64'), 'sk')).toThrow();
  });
});
