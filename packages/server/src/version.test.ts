/**
 * The version constant must equal the package's.
 *
 * `npm version` rewrites package.json and nothing else, so a hand-maintained constant silently keeps
 * the previous release's number. The first v1.1.0 image did exactly that: it answered `1.0.0` to
 * `relay --version` and on the /readyz probe the console's Status page reads — the one place an
 * operator looks to confirm what is actually deployed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELAY_VERSION } from './version.js';

describe('RELAY_VERSION', () => {
  it('matches the version in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(RELAY_VERSION).toBe(manifest.version);
  });
});
