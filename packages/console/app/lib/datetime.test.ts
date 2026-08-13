import { describe, it, expect } from 'vitest';
import { utcLabel, localLabel } from './datetime';

const ISO = '2026-08-09T18:35:20.509Z';

describe('utcLabel — the server-safe half', () => {
  /**
   * This is the property the whole fix rests on: a Server Component and the browser's first render
   * must produce identical bytes, or React reports a hydration mismatch. Nothing here may depend on
   * the host's timezone or locale.
   */
  it('is deterministic and explicitly UTC', () => {
    expect(utcLabel(ISO)).toBe('2026-08-09 18:35 UTC');
    expect(utcLabel(ISO, 'time')).toBe('18:35:20 UTC');
  });

  it('derives from toISOString, so it cannot drift with the host timezone', () => {
    // Asserted structurally rather than by mutating process.env.TZ: Node caches the zone, and a
    // botched restore (assigning undefined sets the STRING "undefined") silently forces UTC for
    // every test that follows. The exact-string test above is the real guarantee.
    const date = new Date(ISO);
    expect(utcLabel(ISO)).toContain(date.toISOString().slice(0, 10));
    expect(utcLabel(ISO)).toContain(date.toISOString().slice(11, 16));
  });

  it('says UTC out loud, so an unlabelled timestamp is never mistaken for local time', () => {
    // The confusion this module exists to fix: 00:05 IST is the PREVIOUS UTC day.
    expect(utcLabel(ISO)).toContain('UTC');
    expect(utcLabel(ISO, 'time')).toContain('UTC');
  });

  it('renders an em dash for missing or unparseable input, never "Invalid Date"', () => {
    expect(utcLabel(null)).toBe('—');
    expect(utcLabel(undefined)).toBe('—');
    expect(utcLabel('')).toBe('—');
    expect(utcLabel('not a date')).toBe('—');
  });
});

describe('localLabel — the browser half', () => {
  it('renders something for a valid instant', () => {
    expect(localLabel(ISO)).not.toBe('—');
    expect(localLabel(ISO, 'time')).not.toBe('—');
  });

  it('degrades the same way on bad input', () => {
    expect(localLabel(null)).toBe('—');
    expect(localLabel('nope')).toBe('—');
  });

  it('actually differs from UTC when the host is not UTC — otherwise the component is pointless', () => {
    // Asserting a difference unconditionally would be flaky: on a UTC runner (most CI) the two
    // labels legitimately describe the same wall clock. Skip there rather than encode the runner's
    // timezone into the expectation.
    if (new Date(ISO).getTimezoneOffset() === 0) {
      // Host is UTC — the two labels legitimately describe the same wall clock.
      expect(localLabel(ISO)).not.toBe('—');
      return;
    }
    expect(localLabel(ISO)).not.toBe(utcLabel(ISO));
  });
});
