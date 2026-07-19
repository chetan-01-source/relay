// k6 load test (PRD §5 G3 gate). Runs the hot path against the gateway → mockllm.
// The real bench (bench.yml, Day 14) gates p99 < 25ms overhead @ 500 RPS / 2 vCPU; this is the
// developer-local version. Requires k6 (https://k6.io).  Run:  make load   (or)  k6 run test/load/chat-completions.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '15s',
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% errors
    http_req_duration: ['p(95)<250'], // p95 total latency (includes mock upstream time)
  },
};

const BASE = __ENV.RELAY_BASE_URL || 'http://localhost:3000';
const payload = JSON.stringify({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
});
const params = {
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${__ENV.RELAY_LOAD_KEY || 'rk_live_load'}`,
  },
};

export default function () {
  const res = http.post(`${BASE}/v1/chat/completions`, payload, params);
  check(res, {
    'status 200': (r) => r.status === 200,
    'is chat.completion': (r) => r.body.includes('chat.completion'),
  });
}
