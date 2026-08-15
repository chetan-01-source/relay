/**
 * Print the caller's own control-plane token — a DEVELOPMENT-ONLY convenience for exercising
 * `/api/v1/*` from Swagger UI, curl or Postman as a *user* rather than as a service account.
 *
 * It exists because there is otherwise no way to get one. The console calls the gateway from React
 * Server Components, so the bearer is minted in Node and never crosses the browser — there is
 * nothing to copy out of DevTools, and Relay persists no tokens to read out of Postgres. Without
 * this route the only options are patching the console temporarily or driving Logto's authorization
 * flow by hand, and the first is exactly the kind of "temporary" edit that gets committed by
 * accident. Shipping it deliberately, gated, is safer than everyone re-inventing it in a hurry.
 *
 * Two gates, and BOTH are load-bearing:
 *
 *   1. It 404s unless NODE_ENV is development. In production this route does not exist, so it cannot
 *      become an exfiltration endpoint for a token that grants the whole control plane.
 *   2. It requires an authenticated session and returns only THAT caller's token. It cannot mint a
 *      token for anyone else, so it grants a signed-in user nothing they did not already have — it
 *      only makes their own credential legible.
 *
 * For a headless caller — CI, a cron job, a provisioning script — this is the wrong tool. Use a
 * machine service account instead (`make seed-machine`), which needs no session and no browser.
 */
import { getAccessTokenRSC, getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig } from '../../lib/logto';
import { pickOrgId } from '../../lib/org';

export const dynamic = 'force-dynamic';

const RELAY_API_RESOURCE = process.env.RELAY_API_RESOURCE ?? 'https://relay.gateway/api';

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV !== 'development') {
    return Response.json({ error: { message: 'Not found.' } }, { status: 404 });
  }

  const { isAuthenticated, claims } = await getLogtoContext(logtoConfig);
  if (!isAuthenticated) {
    return Response.json(
      { error: { message: 'Sign in to the console first, then reload this URL.' } },
      { status: 401 },
    );
  }

  // The organization the token acts as. Without it Logto omits `organization_id` and the gateway
  // sees no tenant, so every org-scoped route answers 401 — worth reporting rather than hiding.
  const orgId = pickOrgId(claims?.organizations);
  if (!orgId) {
    return Response.json(
      {
        error: {
          message:
            'Your account belongs to no organization, so no org-scoped token can be minted. ' +
            'Create or join one in the console first.',
        },
      },
      { status: 409 },
    );
  }

  const token = await getAccessTokenRSC(logtoConfig, RELAY_API_RESOURCE, orgId);

  return Response.json(
    {
      token,
      organization_id: orgId,
      usage: `curl -H "authorization: Bearer <token>" ${process.env.RELAY_API_BASE_URL ?? 'http://localhost:3000'}/api/v1/me`,
      note: 'Development only. Expires in about an hour. For CI or a cron job use `make seed-machine` instead.',
    },
    // Never let a proxy or the browser retain a bearer token.
    { headers: { 'cache-control': 'no-store' } },
  );
}
