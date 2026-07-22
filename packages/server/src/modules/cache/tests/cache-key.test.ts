import { describe, it, expect } from 'vitest';
import { cacheKeyFor } from '../lib/cache-key.js';
import type { CanonicalRequest } from '../../proxy/index.js';

const base: CanonicalRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello world' }],
};

describe('cacheKeyFor', () => {
  it('is deterministic for the same org + semantic request', () => {
    expect(cacheKeyFor('org-1', base)).toBe(cacheKeyFor('org-1', base));
  });

  it('partitions by org — the same request in two orgs yields different keys', () => {
    expect(cacheKeyFor('org-1', base)).not.toBe(cacheKeyFor('org-2', base));
    expect(cacheKeyFor('org-1', base).startsWith('c:org-1:')).toBe(true);
  });

  it('ignores the stream flag (a stream and non-stream ask share one entry)', () => {
    expect(cacheKeyFor('org-1', { ...base, stream: true })).toBe(
      cacheKeyFor('org-1', { ...base, stream: false }),
    );
  });

  it('changes when a semantic field changes (model, messages, max_tokens)', () => {
    expect(cacheKeyFor('org-1', { ...base, model: 'gpt-4o-mini' })).not.toBe(
      cacheKeyFor('org-1', base),
    );
    expect(
      cacheKeyFor('org-1', { ...base, messages: [{ role: 'user', content: 'other' }] }),
    ).not.toBe(cacheKeyFor('org-1', base));
    expect(cacheKeyFor('org-1', { ...base, max_tokens: 100 })).not.toBe(cacheKeyFor('org-1', base));
  });

  it('buckets temperature so trivially-close values share a slot', () => {
    expect(cacheKeyFor('org-1', { ...base, temperature: 0.71 })).toBe(
      cacheKeyFor('org-1', { ...base, temperature: 0.74 }),
    );
    expect(cacheKeyFor('org-1', { ...base, temperature: 0.7 })).not.toBe(
      cacheKeyFor('org-1', { ...base, temperature: 0.2 }),
    );
  });

  it('includes image-part URLs as the attachment identity', () => {
    const withImg = (url: string): CanonicalRequest => ({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ],
    });
    expect(cacheKeyFor('org-1', withImg('https://a.test/1.png'))).not.toBe(
      cacheKeyFor('org-1', withImg('https://a.test/2.png')),
    );
  });
});
