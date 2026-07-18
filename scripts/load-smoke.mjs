#!/usr/bin/env node
// Zero-dependency local load smoke (fallback when k6 is not installed). Fires N requests at a
// fixed concurrency against the gateway hot path and reports throughput + p50/p95/p99 + errors.
// For the gating benchmark use k6 (test/load/chat-completions.js). Run: node scripts/load-smoke.mjs
const BASE = process.env.RELAY_BASE_URL || 'http://localhost:3000';
const TOTAL = Number(process.env.REQUESTS || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);

const payload = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
const headers = { 'content-type': 'application/json', authorization: 'Bearer rk_live_load' };

const latencies = [];
let ok = 0;
let errors = 0;

async function one() {
  const t = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload,
    });
    await res.text();
    if (res.status === 200) ok++;
    else errors++;
  } catch {
    errors++;
  }
  latencies.push(performance.now() - t);
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const started = performance.now();
let launched = 0;
async function worker() {
  while (launched < TOTAL) {
    launched++;
    await one();
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const wall = (performance.now() - started) / 1000;

const sorted = latencies.sort((a, b) => a - b);
const f = (n) => n.toFixed(1);
console.log(`load-smoke: ${TOTAL} reqs @ concurrency ${CONCURRENCY} -> ${BASE}`);
console.log(`  throughput : ${(TOTAL / wall).toFixed(0)} req/s   wall ${f(wall * 1000)}ms`);
console.log(`  success    : ${ok}/${TOTAL}   errors ${errors}`);
console.log(
  `  latency ms : p50 ${f(pct(sorted, 50))}  p95 ${f(pct(sorted, 95))}  p99 ${f(pct(sorted, 99))}  max ${f(sorted.at(-1))}`,
);

if (errors > 0) {
  console.error('LOAD FAIL: had errors');
  process.exit(1);
}
console.log('LOAD OK');
