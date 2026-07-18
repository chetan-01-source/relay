#!/usr/bin/env node
// G3 bench (PRD §5): drive load through the gateway, then read the gateway's OWN overhead histogram
// (relay_gateway_overhead_seconds = gateway-only latency, in+out, provider excluded) and fail if p99
// exceeds the budget. Measures a clean STEADY-STATE window: a warmup primes JIT, then the quantile is
// computed over the DELTA of two /metrics scrapes so cold/prior samples never pollute the tail. Zero deps.
//   RELAY_BASE_URL RELAY_INTERNAL_URL WARMUP REQUESTS CONCURRENCY OVERHEAD_P99_MAX_MS
const BASE = process.env.RELAY_BASE_URL || 'http://localhost:3000';
const INTERNAL = process.env.RELAY_INTERNAL_URL || 'http://localhost:9090';
const WARMUP = Number(process.env.WARMUP || 200);
const TOTAL = Number(process.env.REQUESTS || 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 25);
const P99_MAX_MS = Number(process.env.OVERHEAD_P99_MAX_MS || 25);
const METRIC = 'relay_gateway_overhead_seconds';

const payload = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
const headers = { 'content-type': 'application/json', authorization: 'Bearer rk_live_bench' };

async function fire() {
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload,
    });
    await res.text();
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Run `count` requests at fixed concurrency; return {ok, errors}. */
async function drive(count) {
  let launched = 0;
  let ok = 0;
  let errors = 0;
  const worker = async () => {
    while (launched < count) {
      launched++;
      (await fire()) ? ok++ : errors++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { ok, errors };
}

/** Parse the histogram into a le→cumulative map + total count. */
async function snapshot() {
  const text = await (await fetch(`${INTERNAL}/metrics`)).text();
  const buckets = new Map();
  const re = new RegExp(`^${METRIC}_bucket\\{le="([^"]+)"\\}\\s+([0-9.]+)`, 'gm');
  let m;
  while ((m = re.exec(text)) !== null)
    buckets.set(m[1] === '+Inf' ? Infinity : Number(m[1]), Number(m[2]));
  const count = Number(new RegExp(`^${METRIC}_count\\s+([0-9.]+)`, 'm').exec(text)?.[1] ?? 0);
  return { buckets, count };
}

/** Quantile over the DELTA between two snapshots (steady-state window only). */
function quantileOverWindow(base, final, q) {
  const les = [...final.buckets.keys()].sort((a, b) => a - b);
  const delta = les.map((le) => ({
    le,
    cum: (final.buckets.get(le) ?? 0) - (base.buckets.get(le) ?? 0),
  }));
  const count = final.count - base.count;
  if (count <= 0 || delta.length === 0) return null;
  const target = q * count;
  let prevLe = 0;
  let prevCum = 0;
  for (const b of delta) {
    if (b.cum >= target) {
      if (b.le === Infinity) return prevLe;
      const span = b.cum - prevCum || 1;
      return prevLe + ((target - prevCum) / span) * (b.le - prevLe);
    }
    prevLe = b.le;
    prevCum = b.cum;
  }
  return delta[delta.length - 1].le;
}

const ms = (s) => (s === null ? 'n/a' : (s * 1000).toFixed(2));

await drive(WARMUP); // prime JIT / connection pools — discarded
const base = await snapshot(); // baseline AFTER warmup
const { ok, errors } = await drive(TOTAL);
const final = await snapshot();

const p50 = quantileOverWindow(base, final, 0.5);
const p99 = quantileOverWindow(base, final, 0.99);

console.log(`bench: ${TOTAL} reqs @ concurrency ${CONCURRENCY} (warmup ${WARMUP}) -> ${BASE}`);
console.log(`  requests   : ${ok} ok, ${errors} errors`);
console.log(`  overhead   : p50 ${ms(p50)}ms  p99 ${ms(p99)}ms   (budget p99 <= ${P99_MAX_MS}ms)`);

if (errors > 0) {
  console.error('BENCH FAIL: request errors');
  process.exit(1);
}
if (p99 === null) {
  console.error('BENCH FAIL: no overhead metric found in the measured window');
  process.exit(1);
}
if (p99 * 1000 > P99_MAX_MS) {
  console.error(`BENCH FAIL: overhead p99 ${ms(p99)}ms > ${P99_MAX_MS}ms (G3)`);
  process.exit(1);
}
console.log('BENCH OK (G3 gate passed)');
