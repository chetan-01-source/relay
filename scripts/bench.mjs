#!/usr/bin/env node
// G3 bench gate (PRD §5): drive load through the gateway, then read the gateway's OWN overhead
// histogram (relay_gateway_overhead_seconds — excludes upstream time) and fail if p99 exceeds the
// budget. This measures added latency, not total, so it is the honest G3 signal. Zero deps.
//   RELAY_BASE_URL RELAY_INTERNAL_URL REQUESTS CONCURRENCY OVERHEAD_P99_MAX_MS
const BASE = process.env.RELAY_BASE_URL || 'http://localhost:3000';
const INTERNAL = process.env.RELAY_INTERNAL_URL || 'http://localhost:9090';
const TOTAL = Number(process.env.REQUESTS || 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 25);
const P99_MAX_MS = Number(process.env.OVERHEAD_P99_MAX_MS || 25);

const payload = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
const headers = { 'content-type': 'application/json', authorization: 'Bearer rk_live_bench' };

let ok = 0;
let errors = 0;
async function fire() {
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload,
    });
    await res.text();
    res.status === 200 ? ok++ : errors++;
  } catch {
    errors++;
  }
}

// Parse a Prometheus histogram and estimate a quantile by linear interpolation across buckets.
function histogramQuantile(metricsText, metric, q) {
  const buckets = [];
  let count = 0;
  const bucketRe = new RegExp(`^${metric}_bucket\\{le="([^"]+)"\\}\\s+([0-9.]+)`, 'gm');
  let m;
  while ((m = bucketRe.exec(metricsText)) !== null) {
    buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), cum: Number(m[2]) });
  }
  const countMatch = new RegExp(`^${metric}_count\\s+([0-9.]+)`, 'm').exec(metricsText);
  if (countMatch) count = Number(countMatch[1]);
  if (!count || buckets.length === 0) return null;

  buckets.sort((a, b) => a.le - b.le);
  const target = q * count;
  let prevLe = 0;
  let prevCum = 0;
  for (const b of buckets) {
    if (b.cum >= target) {
      if (b.le === Infinity) return prevLe; // in the overflow bucket — report the last finite edge
      const span = b.cum - prevCum || 1;
      return prevLe + ((target - prevCum) / span) * (b.le - prevLe);
    }
    prevLe = b.le;
    prevCum = b.cum;
  }
  return buckets[buckets.length - 1].le;
}

let launched = 0;
async function worker() {
  while (launched < TOTAL) {
    launched++;
    await fire();
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const metrics = await (await fetch(`${INTERNAL}/metrics`)).text();
const p50 = histogramQuantile(metrics, 'relay_gateway_overhead_seconds', 0.5);
const p99 = histogramQuantile(metrics, 'relay_gateway_overhead_seconds', 0.99);
const ms = (s) => (s === null ? 'n/a' : (s * 1000).toFixed(2));

console.log(`bench: ${TOTAL} reqs @ concurrency ${CONCURRENCY} -> ${BASE}`);
console.log(`  requests   : ${ok} ok, ${errors} errors`);
console.log(`  overhead   : p50 ${ms(p50)}ms  p99 ${ms(p99)}ms   (budget p99 <= ${P99_MAX_MS}ms)`);

if (errors > 0) {
  console.error('BENCH FAIL: request errors');
  process.exit(1);
}
if (p99 === null) {
  console.error('BENCH FAIL: no overhead metric found');
  process.exit(1);
}
if (p99 * 1000 > P99_MAX_MS) {
  console.error(`BENCH FAIL: overhead p99 ${ms(p99)}ms > ${P99_MAX_MS}ms (G3)`);
  process.exit(1);
}
console.log('BENCH OK (G3 gate passed)');
