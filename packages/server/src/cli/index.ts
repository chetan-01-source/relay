#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program.name('relay').description('Relay Gateway CLI').version('0.0.0');

program
  .command('serve')
  .description('start the gateway (data + control planes)')
  .option('--plane <plane>', 'data | control | both', 'both')
  .option('--workers <n>', 'worker count or "auto"', 'auto')
  .action((opts: { plane: string; workers: string }) => {
    // Real server lands sprint Day 3-4.
    console.error(`[relay] serve stub — plane=${opts.plane} workers=${opts.workers}`);
  });

program
  .command('migrate')
  .description('apply SQL migrations (advisory-locked)')
  .action(() => {
    console.error('[relay] migrate stub — lands Day 2');
  });

program
  .command('seed')
  .description('seed demo org/app/key/route')
  .action(() => {
    console.error('[relay] seed stub — lands Day 5');
  });

program.parse();
