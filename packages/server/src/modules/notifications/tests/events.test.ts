import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_EVENTS,
  EVENT_CATALOGUE,
  isNotificationEvent,
  definitionFor,
  dedupeKeyFor,
} from '../lib/events.js';
import { render } from '../lib/templates.js';

describe('event catalogue', () => {
  it('defines every declared event exactly once', () => {
    expect(EVENT_CATALOGUE).toHaveLength(NOTIFICATION_EVENTS.length);
    const ids = EVENT_CATALOGUE.map((d) => d.event);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of NOTIFICATION_EVENTS) expect(definitionFor(event)).toBeDefined();
  });

  it('gives every event a label and description for the preference list', () => {
    for (const def of EVENT_CATALOGUE) {
      expect(def.label, def.event).toBeTruthy();
      expect(def.description, def.event).toBeTruthy();
    }
  });

  it('defaults spend and security events ON, routine config changes OFF', () => {
    // Missing a budget breach or a revoked key is expensive; a budget edit is not worth an inbox.
    expect(definitionFor('budget.exceeded')?.defaultEnabled).toBe(true);
    expect(definitionFor('org.suspended')?.defaultEnabled).toBe(true);
    expect(definitionFor('key.revoked')?.defaultEnabled).toBe(true);
    expect(definitionFor('budget.updated')?.defaultEnabled).toBe(false);
  });

  it('narrows untrusted values', () => {
    expect(isNotificationEvent('budget.exceeded')).toBe(true);
    expect(isNotificationEvent('budget.exploded')).toBe(false);
    expect(isNotificationEvent('')).toBe(false);
  });
});

describe('dedupeKeyFor', () => {
  // Without this a tripped ceiling mails the org once per REJECTED REQUEST — thousands of times.
  it('produces one key per ceiling per period for high-volume events', () => {
    const first = dedupeKeyFor('budget.exceeded', { scope: 'app-1', window: '2026-08' });
    const again = dedupeKeyFor('budget.exceeded', { scope: 'app-1', window: '2026-08' });
    expect(first).toBe(again);
    expect(first).toBe('budget.exceeded:app-1:2026-08');
  });

  it('mails again next period, because the window is part of the key', () => {
    expect(dedupeKeyFor('budget.exceeded', { scope: 'app-1', window: '2026-08' })).not.toBe(
      dedupeKeyFor('budget.exceeded', { scope: 'app-1', window: '2026-09' }),
    );
  });

  it('separates ceilings, so an app breach does not suppress the org one', () => {
    expect(dedupeKeyFor('budget.exceeded', { scope: 'app-1', window: '2026-08' })).not.toBe(
      dedupeKeyFor('budget.exceeded', { scope: 'org', window: '2026-08' }),
    );
  });

  it('returns null for events where every occurrence deserves its own mail', () => {
    expect(dedupeKeyFor('member.removed')).toBeNull();
    expect(dedupeKeyFor('key.revoked')).toBeNull();
    expect(dedupeKeyFor('budget.updated')).toBeNull();
  });
});

describe('templates', () => {
  it('renders a subject and body for every catalogued event', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const message = render(event, { orgName: 'Acme' });
      expect(message.subject, event).toBeTruthy();
      expect(message.text, event).toBeTruthy();
    }
  });

  it('states the numbers that make a budget alert actionable', () => {
    const message = render('budget.exceeded', {
      orgName: 'Acme',
      scope: 'test-app',
      period: 'monthly',
      limitUsd: 0.0001,
      spentUsd: 0.00054,
    });
    expect(message.subject).toContain('test-app');
    expect(message.text).toContain('$0.000100'); // full precision, not $0.00
    expect(message.text).toContain('$0.000540');
    expect(message.text).toContain('budget_exceeded');
  });

  it('degrades to readable copy when the payload is empty', () => {
    const message = render('budget.exceeded', {});
    expect(message.text).toContain('your organization');
    expect(message.text).toContain('n/a'); // missing amounts say so rather than rendering NaN
  });

  it('always tells the reader how to stop receiving it', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(render(event, {}).text.toLowerCase(), event).toContain('preferences');
    }
  });
});
