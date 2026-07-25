/**
 * Server-only reader for the gateway's internal readiness probe (Day 14). The internal port is not
 * public, so this runs on the Next server (never the browser) and points at RELAY_INTERNAL_URL — the
 * gateway's health/metrics listener (localhost:9090 in dev; the service address in production). A
 * fetch failure is a first-class result (`reachable: false`), not an exception, so the Status page can
 * render an honest "unreachable" state instead of crashing.
 */
const INTERNAL_URL = process.env.RELAY_INTERNAL_URL ?? 'http://localhost:9090';

export interface GatewayHealth {
  reachable: boolean;
  status?: 'ready' | 'not-ready';
  pg?: boolean;
  valkey?: boolean;
  warm?: boolean;
  version?: string;
  endpoint: string;
}

/** Read `/readyz`. Never throws — a down gateway resolves to `{ reachable: false }`. */
export async function getGatewayHealth(): Promise<GatewayHealth> {
  try {
    const res = await fetch(`${INTERNAL_URL}/readyz`, { cache: 'no-store' });
    // /readyz returns 503 when a dependency is down but still ships a JSON body we want to show.
    const body = (await res.json()) as Omit<GatewayHealth, 'reachable' | 'endpoint'>;
    return { reachable: true, endpoint: INTERNAL_URL, ...body };
  } catch {
    return { reachable: false, endpoint: INTERNAL_URL };
  }
}
