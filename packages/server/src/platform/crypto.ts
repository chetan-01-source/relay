/**
 * Envelope encryption for provider credentials (PRD §4 Day 3 · playbook §3).
 * Per-credential DEK (random 32B) encrypts the plaintext with AES-256-GCM; the DEK is
 * itself wrapped by the master KEK (RELAY_MASTER_KEY). Plaintext exists only transiently
 * in worker memory at send time — never logged, never stored.
 */
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce
const KEY_LEN = 32;

/**
 * Deterministic keyed hash for a virtual key, for storage + O(1) indexed lookup.
 *
 * Virtual keys are HIGH-ENTROPY random tokens (192-bit), not human passwords — so a fast keyed hash
 * is the correct construction, NOT a slow password KDF (PBKDF2/bcrypt/argon2). A slow, per-row-salted
 * hash would also break the unique-index lookup the gateway relies on to resolve a key in O(1).
 * The server-side pepper (derived from RELAY_MASTER_KEY) means an attacker with only the database
 * cannot verify guessed keys offline. This is the GitHub/Stripe token-hashing model.
 */
export function hashVirtualKey(masterKeyB64: string, apiKey: string): Buffer {
  const pepper = createHmac('sha256', kek(masterKeyB64)).update('relay/virtual-key/v1').digest();
  return createHmac('sha256', pepper).update(apiKey).digest();
}

export interface SealedCredential {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer; // DEK encrypted under the KEK (iv+tag prefixed)
}

function encryptGcm(key: Buffer, plaintext: Buffer): { ct: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ct, iv, tag: cipher.getAuthTag() };
}

function decryptGcm(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function kek(masterKeyB64: string): Buffer {
  const k = Buffer.from(masterKeyB64, 'base64');
  if (k.length !== KEY_LEN) throw new Error('RELAY_MASTER_KEY must decode to 32 bytes');
  return k;
}

/** Seal a plaintext provider key. Returns columns to store in provider_credentials. */
export function sealCredential(masterKeyB64: string, plaintext: string): SealedCredential {
  const dek = randomBytes(KEY_LEN);
  const data = encryptGcm(dek, Buffer.from(plaintext, 'utf8'));
  // wrap the DEK under the KEK; pack iv||tag||ciphertext so one column round-trips it
  const wrap = encryptGcm(kek(masterKeyB64), dek);
  const wrappedDek = Buffer.concat([wrap.iv, wrap.tag, wrap.ct]);
  return { ciphertext: data.ct, iv: data.iv, authTag: data.tag, wrappedDek };
}

/** Open a sealed credential back to plaintext — call only at send time, in worker memory. */
export function openCredential(masterKeyB64: string, sealed: SealedCredential): string {
  const wiv = sealed.wrappedDek.subarray(0, IV_LEN);
  const wtag = sealed.wrappedDek.subarray(IV_LEN, IV_LEN + 16);
  const wct = sealed.wrappedDek.subarray(IV_LEN + 16);
  const dek = decryptGcm(kek(masterKeyB64), wiv, wtag, wct);
  return decryptGcm(dek, sealed.iv, sealed.authTag, sealed.ciphertext).toString('utf8');
}
