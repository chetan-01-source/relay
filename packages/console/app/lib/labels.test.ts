import { describe, it, expect } from 'vitest';
import {
  labelOf,
  appNames,
  routeNames,
  memberNames,
  keyNames,
  providerNames,
  bucketLabel,
  auditTargetLabel,
  shortId,
} from './labels';
import type { Application, RouteSummary, Member } from './api';

const APP_ID = '9f1c2e3d-0000-4000-8000-000000000001';
const ROUTE_ID = '1604fdfa-d2de-43c5-b90e-fd892649d8ee';

describe('labelOf', () => {
  it('resolves a name while keeping the id — both halves are load-bearing', () => {
    expect(labelOf(new Map([[APP_ID, 'Checkout']]), APP_ID)).toEqual({
      name: 'Checkout',
      id: APP_ID,
    });
  });

  it('keeps the id when nothing resolves, so a deleted reference is still traceable', () => {
    expect(labelOf(new Map(), APP_ID)).toEqual({ name: null, id: APP_ID });
  });

  it('treats a missing id as empty rather than throwing', () => {
    expect(labelOf(new Map(), null)).toEqual({ name: null, id: '' });
    expect(labelOf(new Map(), undefined)).toEqual({ name: null, id: '' });
  });
});

describe('name maps', () => {
  it('indexes applications by id', () => {
    const apps = [{ id: APP_ID, name: 'Checkout' }] as Application[];
    expect(appNames(apps).get(APP_ID)).toBe('Checkout');
  });

  it('labels a route by its client-facing model name — what a route is to a caller', () => {
    const routes = [{ id: ROUTE_ID, model_name: 'fast-chat' }] as RouteSummary[];
    expect(routeNames(routes).get(ROUTE_ID)).toBe('fast-chat');
  });

  it('prefers a member name but falls back to email, which still identifies a person', () => {
    const members = [
      { id: 'u1', name: 'Ada', email: 'ada@example.com' },
      { id: 'u2', email: 'grace@example.com' },
    ] as Member[];
    const names = memberNames(members);
    expect(names.get('u1')).toBe('Ada');
    expect(names.get('u2')).toBe('grace@example.com');
  });

  it('falls back to a key fingerprint when the key was never named', () => {
    const names = keyNames([
      { id: 'k1', name: 'ci' },
      { id: 'k2', last4: 'a1b2' },
    ]);
    expect(names.get('k1')).toBe('ci');
    expect(names.get('k2')).toBe('…a1b2');
  });

  it('skips entries missing either half instead of mapping to undefined', () => {
    expect(appNames([{ id: APP_ID }, { name: 'no id' }] as Application[]).size).toBe(0);
    expect(keyNames([{ id: 'k3' }]).size).toBe(0);
    expect(providerNames([{ id: 'p1', name: 'prod-openai' }]).get('p1')).toBe('prod-openai');
  });
});

describe('bucketLabel', () => {
  const maps = {
    apps: new Map([[APP_ID, 'Checkout']]),
    routes: new Map([[ROUTE_ID, 'fast-chat']]),
  };

  it('resolves app and route buckets, which the API returns as bare ids', () => {
    expect(bucketLabel('app', APP_ID, maps)).toEqual({ name: 'Checkout', id: APP_ID });
    expect(bucketLabel('route', ROUTE_ID, maps)).toEqual({ name: 'fast-chat', id: ROUTE_ID });
  });

  it('passes model and day buckets through — those keys are already human-readable', () => {
    expect(bucketLabel('model', 'gpt-4o-mini', maps)).toEqual({ name: 'gpt-4o-mini', id: '' });
    expect(bucketLabel('day', '2026-08-09', maps)).toEqual({ name: '2026-08-09', id: '' });
  });

  it('keeps an unresolvable id visible rather than blanking the row', () => {
    expect(bucketLabel('app', 'deleted-app', maps)).toEqual({ name: null, id: 'deleted-app' });
  });
});

describe('auditTargetLabel', () => {
  const maps = {
    apps: new Map([[APP_ID, 'Checkout']]),
    routes: new Map([[ROUTE_ID, 'fast-chat']]),
    providers: new Map([['p1', 'prod-openai']]),
  };

  it('picks the map implied by the action prefix', () => {
    expect(auditTargetLabel('route.delete', ROUTE_ID, maps).name).toBe('fast-chat');
    expect(auditTargetLabel('provider.create', 'p1', maps).name).toBe('prod-openai');
    expect(auditTargetLabel('app.create', APP_ID, maps).name).toBe('Checkout');
    // Keys live under an application, so key.* actions resolve against the app map.
    expect(auditTargetLabel('key.revoke', APP_ID, maps).name).toBe('Checkout');
  });

  it('does not guess for an unrecognised action — it shows the raw id', () => {
    expect(auditTargetLabel('org.suspend', ROUTE_ID, maps)).toEqual({ name: null, id: ROUTE_ID });
  });

  it('handles a missing target (some actions have none)', () => {
    expect(auditTargetLabel('org.create', null, maps)).toEqual({ name: null, id: '' });
  });
});

describe('shortId', () => {
  it('truncates a long id and leaves a short one alone', () => {
    expect(shortId(ROUTE_ID)).toBe('1604fdfa…');
    expect(shortId('u1')).toBe('u1');
  });
});
