import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { manifestImages, sniffImage } from '../lib/image-manifest.js';
import type { CanonicalRequest } from '../types/proxy.types.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a\x00\x00', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(4),
]);

function dataUri(mime: string | null, bytes: Buffer): string {
  const header = mime ? `${mime};base64` : ';base64';
  return `data:${header},${bytes.toString('base64')}`;
}

function req(content: CanonicalRequest['messages'][number]['content']): CanonicalRequest {
  return { model: 'gpt-4o', messages: [{ role: 'user', content }] };
}

describe('sniffImage', () => {
  it('recognizes png/jpeg/gif/webp by magic bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
  });

  it('returns null for non-image bytes', () => {
    expect(sniffImage(Buffer.from('not an image'))).toBeNull();
  });
});

describe('manifestImages', () => {
  it('is a no-op for text-only messages (string content, no decode work)', () => {
    expect(manifestImages(req('hello'))).toEqual({ ok: true, attachments: [] });
  });

  it('manifests a valid inline png with its sniffed mime, size, and sha256', () => {
    const result = manifestImages(
      req([
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: dataUri('image/png', PNG) } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toEqual({
        index: 0,
        mime: 'image/png',
        bytes: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
      });
    }
  });

  it('accepts a data URI with no declared mime (sniffs the real type)', () => {
    const result = manifestImages(
      req([{ type: 'image_url', image_url: { url: dataUri(null, JPEG) } }]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachments[0]?.mime).toBe('image/jpeg');
  });

  it('rejects a declared mime that disagrees with the content (anti-spoof)', () => {
    const result = manifestImages(
      req([{ type: 'image_url', image_url: { url: dataUri('image/gif', PNG) } }]),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'inline image #0 declares image/gif but content is image/png',
    });
  });

  it('rejects non-image bytes smuggled as a data URI', () => {
    const junk = Buffer.from('#!/bin/sh\nrm -rf /');
    const result = manifestImages(
      req([{ type: 'image_url', image_url: { url: dataUri('image/png', junk) } }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not a recognized image');
  });

  it('rejects an oversized inline image', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const result = manifestImages(
      req([{ type: 'image_url', image_url: { url: dataUri('image/png', big) } }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('exceeds');
  });

  it('rejects a malformed data URI (no base64) and an empty payload', () => {
    expect(
      manifestImages(req([{ type: 'image_url', image_url: { url: 'data:image/png,notbase64' } }]))
        .ok,
    ).toBe(false);
    expect(
      manifestImages(
        req([{ type: 'image_url', image_url: { url: dataUri('image/png', Buffer.alloc(0)) } }]),
      ).ok,
    ).toBe(false);
  });

  it('passes remote http(s) image URLs through without fetching or sniffing', () => {
    const result = manifestImages(
      req([{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }]),
    );
    expect(result).toEqual({ ok: true, attachments: [] });
  });

  it('indexes multiple inline images in order', () => {
    const result = manifestImages(
      req([
        { type: 'image_url', image_url: { url: dataUri('image/png', PNG) } },
        { type: 'image_url', image_url: { url: dataUri('image/jpeg', JPEG) } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachments.map((a) => a.index)).toEqual([0, 1]);
  });
});
