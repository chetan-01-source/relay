#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, redactedConfig } from '../platform/config.js';
import { createLogger } from '../platform/logger.js';
import { initDb } from '../platform/db.js';
import { createEventBus } from '../platform/eventbus.js';
import { buildServers, buildPublicApp } from '../app.js';
import { runMigrations } from '../platform/migrate.js';
import { bootstrapLogto } from '../platform/logto.js';
import { seedDemo } from '../seed/demo.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Resolve the monorepo root (pnpm --filter runs the CLI from the package dir, not the root). */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const program = new Command();
program.name('relay').description('Relay Gateway CLI').version('0.2.0');

program
  .command('serve')
  .description('start the gateway (data + control planes)')
  .option('--plane <plane>', 'data | control | both', 'both')
  .option('--workers <n>', 'worker count or "auto"', 'auto')
  .action(async () => {
    const config = loadConfig();
    const log = createLogger(config.RELAY_LOG_LEVEL);
    log.info({ config: redactedConfig(config) }, 'relay booting');

    const db = initDb(config.RELAY_DATABASE_URL);
    const bus = createEventBus(config.RELAY_VALKEY_URL);
    const { publicApp, internalApp } = await buildServers(config, { db, bus });

    await internalApp.listen({ port: config.RELAY_INTERNAL_PORT, host: '0.0.0.0' });
    await publicApp.listen({ port: config.RELAY_PORT, host: '0.0.0.0' });
    log.info(
      { data: config.RELAY_PORT, internal: config.RELAY_INTERNAL_PORT },
      'relay listening — data plane + internal (health/metrics)',
    );

    const shutdown = async (sig: string) => {
      log.info({ sig }, 'graceful shutdown');
      await Promise.allSettled([publicApp.close(), internalApp.close(), db.close(), bus.close()]);
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  });

program
  .command('migrate')
  .description('apply SQL migrations (advisory-locked, checksummed)')
  .action(async () => {
    const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
    if (!url) {
      console.error('[relay] set RELAY_MIGRATION_DATABASE_URL (postgres superuser) to migrate');
      process.exit(1);
    }
    const result = await runMigrations(url);
    for (const f of result.applied) console.error(`[relay] applied  ${f}`);
    for (const f of result.skipped) console.error(`[relay] skipped  ${f} (already applied)`);
    console.error(
      `[relay] migrate done — ${result.applied.length} applied, ${result.skipped.length} up-to-date`,
    );
    process.exit(0);
  });

program
  .command('seed-auth')
  .description('idempotent Logto bootstrap (API resource + roles)')
  .action(async () => {
    const endpoint = process.env.RELAY_LOGTO_ENDPOINT;
    const m2mAppId = process.env.RELAY_LOGTO_M2M_APP_ID;
    const m2mAppSecret = process.env.RELAY_LOGTO_M2M_APP_SECRET;
    if (!endpoint || !m2mAppId || !m2mAppSecret) {
      console.error('[relay] seed-auth skipped — Logto M2M not configured.');
      console.error(
        '  One-time setup: in the Logto Admin Console create a Machine-to-Machine app,',
      );
      console.error('  grant it "Logto Management API access", then set in .env:');
      console.error(
        '    RELAY_LOGTO_ENDPOINT · RELAY_LOGTO_M2M_APP_ID · RELAY_LOGTO_M2M_APP_SECRET',
      );
      process.exit(0);
    }
    const result = await bootstrapLogto({ endpoint, m2mAppId, m2mAppSecret });
    console.error(`[relay] logto bootstrap ok — apiResource ${result.apiResourceId}`);
    console.error(
      result.created.length
        ? `  created: ${result.created.join(', ')}`
        : '  already up-to-date (idempotent)',
    );
    process.exit(0);
  });

program
  .command('seed-demo')
  .description('seed a demo org/app/key/route and print a working curl')
  .action(async () => {
    const url = process.env.RELAY_MIGRATION_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
    const masterKey = process.env.RELAY_MASTER_KEY;
    const upstream = process.env.RELAY_UPSTREAM_URL ?? 'http://localhost:8080';
    if (!url || !masterKey) {
      console.error('[relay] seed-demo needs RELAY_(MIGRATION_)DATABASE_URL and RELAY_MASTER_KEY');
      process.exit(1);
    }
    const { apiKey, curl } = await seedDemo(url, masterKey, upstream);
    console.error('[relay] demo tenant seeded. Virtual key (shown once — store it now):');
    console.error(`\n  ${apiKey}\n`);
    console.error('Try it (start the stack first: make dev):\n');
    console.error(`${curl}\n`);
    process.exit(0);
  });

program
  .command('openapi')
  .description('dump the OpenAPI 3.1 spec to api/openapi/openapi.json')
  .action(async () => {
    // stub Queryable — routes are only registered (for the spec), never executed, so no DB is needed
    const app = await buildPublicApp({
      db: { run: () => Promise.resolve([]) },
      upstreamUrl: 'http://localhost:8080',
    });
    await app.ready();
    const spec = app.swagger();
    const out = path.resolve(repoRoot(), 'api/openapi/openapi.json');
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
    await app.close();
    console.error(`[relay] wrote ${out}`);
    process.exit(0);
  });

void program.parseAsync();
