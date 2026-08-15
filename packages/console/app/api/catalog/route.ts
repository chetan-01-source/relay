/**
 * Same-origin proxy for the model catalog.
 *
 * The picker is a client component, so it cannot call the gateway directly — the control-plane
 * bearer is minted server-side and must never reach the browser. This handler attaches it, which
 * also means no CORS allowance has to be opened on the gateway for the console's origin.
 *
 * Read-only and session-gated: it returns nothing a signed-in user could not already see on the
 * models page.
 */
import { searchCatalog } from '../../lib/api';
import { requireOrg } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  await requireOrg();

  const params = new URL(request.url).searchParams;
  const provider = params.get('provider');
  const q = params.get('q');
  const limit = Number(params.get('limit'));

  try {
    const result = await searchCatalog({
      ...(provider ? { provider } : {}),
      ...(q ? { q } : {}),
      // Clamped here as well as at the gateway: this route is reachable from the browser, so the
      // bound belongs on both sides rather than only on the one the picker happens to send.
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
    });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch {
    // The picker degrades to free-text entry, which is always valid — a failed lookup must not
    // block configuring a route.
    return Response.json({ object: 'list', data: [], counts: {} }, { status: 200 });
  }
}
