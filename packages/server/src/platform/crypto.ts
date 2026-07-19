/**
 * Envelope encryption for provider credentials (PRD §4 Day 3 · playbook §3).
 * Per-credential DEK (random 32B) encrypts the plaintext with AES-256-GCM; the DEK is
 * itself wrapped by the master KEK (RELAY_MASTER_KEY). Plaintext exists only transiently
 * in worker memory at send time — never logged, never stored.
 */
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce
const KEY_LEN = 32;
const VKEY_ITERATIONS = 100_000;

const KEY_ID_BYTES = 16; // public lookup selector — indexed, not secret
const SECRET_BYTES = 24; // 192-bit random secret half — the actual credential
export type VirtualKeyEnvironment = 'live' | 'test';

/** The three fields a freshly minted key yields. Plaintext is shown to the caller exactly once. */
export interface MintedVirtualKey {
  plaintext: string; // rk_<env>_<keyId>.<secret> — never stored
  keyId: string; // public selector — stored in virtual_keys.key_id (indexed)
  secretVerifier: Buffer; // PBKDF2(secret, pepper) — stored in virtual_keys.key_sha256
  last4: string; // display only
}

/** The parts parsed out of a presented key. Never logged. */
export interface ParsedVirtualKey {
  environment: VirtualKeyEnvironment;
  keyId: string;
  secret: string;
}

// rk_<env>_<keyId>.<secret> — env is live|test, keyId/secret are base64url (no dot inside either).
const VKEY_RE = /^rk_(live|test)_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * Deterministic verifier for a virtual key's SECRET half — for storage + timing-safe verification.
 *
 * Uses PBKDF2-HMAC-SHA256 (a KDF) with a DETERMINISTIC, server-side salt derived from
 * RELAY_MASTER_KEY — not a random per-row salt. Determinism is deliberate: the resolver first finds
 * the row by the public key_id (a fast unique-index probe, no hashing), then verifies the presented
 * secret against this value, so the same secret must always derive the same verifier. The
 * pepper-as-salt means an attacker with only the database cannot verify guessed secrets offline.
 * Secrets are high-entropy (192-bit) random tokens, so the iteration count is defense-in-depth
 * rather than the primary barrier; the resolver derives this only on a snapshot miss, never per
 * request on the hot path.
 */
export function hashVirtualKey(masterKeyB64: string, secret: string): Buffer {
  const salt = createHmac('sha256', kek(masterKeyB64)).update('relay/virtual-key/salt/v1').digest();
  return pbkdf2Sync(secret, salt, VKEY_ITERATIONS, KEY_LEN, 'sha256');
}

/** Mint a new virtual key: public keyId selector + random secret + its stored verifier. */
export function mintVirtualKey(
  masterKeyB64: string,
  environment: VirtualKeyEnvironment = 'live',
): MintedVirtualKey {
  const keyId = randomBytes(KEY_ID_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const plaintext = `rk_${environment}_${keyId}.${secret}`;
  return {
    plaintext,
    keyId,
    secretVerifier: hashVirtualKey(masterKeyB64, secret),
    last4: secret.slice(-4),
  };
}

/** Parse a presented key into its parts, or null if the shape is invalid. Never throws on input. */
export function parseVirtualKey(plaintext: string): ParsedVirtualKey | null {
  const m = VKEY_RE.exec(plaintext);
  if (!m) return null;
  return { environment: m[1] as VirtualKeyEnvironment, keyId: m[2]!, secret: m[3]! };
}

/** Constant-time check of a presented secret against a stored verifier. */
export function verifyVirtualKeySecret(
  masterKeyB64: string,
  secret: string,
  storedVerifier: Buffer,
): boolean {
  const candidate = hashVirtualKey(masterKeyB64, secret);
  return candidate.length === storedVerifier.length && timingSafeEqual(candidate, storedVerifier);
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
