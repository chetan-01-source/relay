/**
 * Inline image manifest (Week 3 Day 12d) — PURE, so it is exhaustively unit-testable. At ingress the
 * proxy validates every inline `data:` image attachment: it decodes the base64, sniffs the real image
 * type from magic bytes, and hashes the bytes (sha256). This is a data-integrity / anti-smuggling
 * guard — a request cannot pass non-image bytes off as an image, and a declared MIME that disagrees
 * with the actual content is rejected. Remote (`http(s)://`) image URLs pass through untouched: the
 * gateway never fetches them on the hot path (non-negotiable #3), so they cannot be sniffed here.
 *
 * The exact-cache key already folds each image URL/data-URI into the tenant-isolated key
 * (modules/cache/lib/cache-key.ts), so this module only validates + manifests; it does not re-key.
 */
import { createHash } from 'node:crypto';
import type { CanonicalRequest } from '../types/proxy.types.js';

/** A validated inline image attachment. `index` is its ordinal among all inline images in the request. */
export interface ImageAttachment {
  index: number;
  mime: string; // sniffed from magic bytes, not trusted from the data-URI header
  bytes: number; // decoded size
  sha256: string; // hex digest of the decoded bytes — the attachment identity
}

/** Ceiling on a single inline image (the global 5 MB body limit bounds the whole request; this bounds
 * one decoded attachment so a request cannot smuggle one enormous blob). */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Magic-byte sniffers for the image types the gateway recognizes. Order does not matter — the
 * signatures are disjoint. Each returns true only when the buffer starts with that format's marker. */
const SNIFFERS: { mime: string; matches: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC) },
  {
    mime: 'image/jpeg',
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/gif',
    matches: (b) =>
      b.length >= 6 &&
      (b.subarray(0, 6).toString('latin1') === 'GIF87a' ||
        b.subarray(0, 6).toString('latin1') === 'GIF89a'),
  },
  {
    mime: 'image/webp',
    matches: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify an image by its magic bytes, or null if it is not a recognized image. */
export function sniffImage(bytes: Buffer): string | null {
  for (const sniffer of SNIFFERS) if (sniffer.matches(bytes)) return sniffer.mime;
  return null;
}

/** The outcome of manifesting a request. On failure the controller maps `reason` to a 400
 * invalid_request — the request never reaches routing or the upstream. */
export type ImageManifestResult =
  { ok: true; attachments: ImageAttachment[] } | { ok: false; reason: string };

/**
 * Validate + manifest every inline image in a request. Text-only requests return immediately with no
 * attachments (the common hot-path case — no decode work). A `data:` image that is not a real image,
 * whose declared MIME disagrees with its content, or that exceeds the size cap fails loud.
 */
export function manifestImages(req: CanonicalRequest): ImageManifestResult {
  const attachments: ImageAttachment[] = [];
  let index = 0;

  for (const message of req.messages) {
    if (!Array.isArray(message.content)) continue; // plain-string content has no attachments
    for (const part of message.content) {
      if (part.type !== 'image_url') continue;
      const url = part.image_url.url;
      if (!url.startsWith('data:')) continue; // remote URL — passed through, not fetched/sniffed

      const parsed = parseDataUri(url);
      if (!parsed)
        return { ok: false, reason: `inline image #${index} is not a valid base64 data URI` };

      const bytes = Buffer.from(parsed.base64, 'base64');
      if (bytes.length === 0) return { ok: false, reason: `inline image #${index} is empty` };
      if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
        return {
          ok: false,
          reason: `inline image #${index} exceeds ${MAX_INLINE_IMAGE_BYTES} bytes`,
        };
      }

      const sniffed = sniffImage(bytes);
      if (!sniffed)
        return { ok: false, reason: `inline image #${index} is not a recognized image` };
      if (parsed.declaredMime && parsed.declaredMime !== sniffed) {
        return {
          ok: false,
          reason: `inline image #${index} declares ${parsed.declaredMime} but content is ${sniffed}`,
        };
      }

      attachments.push({
        index,
        mime: sniffed,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      index++;
    }
  }

  return { ok: true, attachments };
}

/** Parse `data:[<mime>][;base64],<payload>`. Only base64 payloads are accepted (an image is binary). */
function parseDataUri(url: string): { declaredMime: string | null; base64: string } | null {
  const comma = url.indexOf(',');
  if (comma === -1) return null;
  const header = url.slice(5, comma); // strip 'data:'
  const payload = url.slice(comma + 1);
  if (!/;base64$/i.test(header)) return null;
  const declaredMime = header.replace(/;base64$/i, '').trim() || null;
  return { declaredMime, base64: payload };
}
