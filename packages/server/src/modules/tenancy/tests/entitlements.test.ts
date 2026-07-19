import { describe, it, expect } from 'vitest';
import { resolveTemplate, ENTITLEMENT_TEMPLATES, DEFAULT_TEMPLATE } from '../lib/entitlements.js';

describe('entitlement templates', () => {
  it('resolves each named template to its feature map', () => {
    expect(resolveTemplate('internal')).toEqual(ENTITLEMENT_TEMPLATES.internal);
    expect(resolveTemplate('trial')).toEqual(ENTITLEMENT_TEMPLATES.trial);
  });

  it('falls back to the default template when none is given', () => {
    expect(resolveTemplate(undefined)).toEqual(ENTITLEMENT_TEMPLATES[DEFAULT_TEMPLATE]);
  });

  it('internal enables more than trial (sanity on the bundles)', () => {
    expect(ENTITLEMENT_TEMPLATES.internal['modalities.image']).toBe(true);
    expect(ENTITLEMENT_TEMPLATES.trial['modalities.image']).toBe(false);
  });
});
