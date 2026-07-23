# Response-header contract (data plane)

Every response from `POST /v1/chat/completions` carries the headers below — on the non-stream path,
the streaming path, and cache hits. The console and SDKs may depend on them. Frozen in Week 3 Day 12
(ADR 0010); asserted in `scripts/smoke.sh`.

| Header                           | Always?                   | Meaning                                                                     |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `x-relay-trace-id`               | yes                       | Correlation id; also the `request_id` on the usage event and log lines.     |
| `x-relay-provider`               | yes                       | Upstream provider actually used (`openai`/`anthropic`/…), or `cache`.       |
| `x-relay-cache`                  | yes                       | `miss` or `hit-exact`.                                                      |
| `x-relay-failover`               | yes                       | `true` if the request failed over to a lower-priority target, else `false`. |
| `x-relay-cost-usd`               | yes                       | Settled cost = `usage × rate card`, 6 dp. See streaming caveat below.       |
| `x-relay-modalities`             | yes                       | Comma list: `text` always; `image` when a message carries an image part.    |
| `x-ratelimit-limit-requests`     | when a rate limit applies | Per-window request ceiling (from the policy decision).                      |
| `x-ratelimit-remaining-requests` | when a rate limit applies | Requests left in the window.                                                |
| `x-ratelimit-limit-tokens`       | when a rate limit applies | Per-window token ceiling.                                                   |
| `x-ratelimit-remaining-tokens`   | when a rate limit applies | Tokens left in the window.                                                  |
| `retry-after`                    | on `429`                  | Seconds to wait before retrying.                                            |

## Cost on streaming responses

Streaming writes its headers atomically before the first byte, but token usage typically arrives in the
final SSE chunk — **after** the headers are already sent. So on a stream, `x-relay-cost-usd` reflects
only what is known at header time (often `0.000000`). The exact settled cost is always recorded on the
metered usage event and the hourly rollups, and is reported by the analytics API — not this header.

## Cache hits

A cache hit sets `x-relay-provider: cache`, `x-relay-cache: hit-exact`, `x-relay-failover: false`, and
`x-relay-cost-usd: 0.000000` (a hit skips the upstream, so it incurs no provider cost). Rate limits
still apply to a hit, so the `x-ratelimit-*` headers are still present.
