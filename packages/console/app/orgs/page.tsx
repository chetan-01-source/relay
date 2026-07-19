/**
 * Tenancy console (Week 2 Day 7 · FE-1) — onboard-org wizard + per-org entitlement matrix.
 *
 * Server-side rendering, gated by scope: the page asks the gateway who the caller is (getMe reads the
 * verified access token) and renders the admin tools ONLY for a platform admin. Non-admins get a
 * plain message — the sensitive controls are never sent to their browser. The gateway is still the
 * real authority; this check is defense-in-depth + good UX.
 */
import { getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig, logtoConfigured } from '../lib/logto';
import { getMe, listOrgs, getEntitlements } from '../lib/api';
import { FEATURE_KEYS } from '../lib/features';
import { onboardOrgAction, updateEntitlementsAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function OrgsPage() {
  if (!logtoConfigured) {
    return (
      <main>
        <h1>Organizations</h1>
        <p>Logto is not configured.</p>
      </main>
    );
  }

  const { isAuthenticated } = await getLogtoContext(logtoConfig);
  if (!isAuthenticated) {
    return (
      <main>
        <h1>Organizations</h1>
        <p>
          Please <a href="/">sign in</a> first.
        </p>
      </main>
    );
  }

  const me = await getMe().catch(() => null);
  if (!me?.is_platform_admin) {
    return (
      <main>
        <h1>Organizations</h1>
        <p>You need platform-admin access to manage tenants.</p>
      </main>
    );
  }

  const list = await listOrgs();
  // The generated types mark every field optional; keep only rows with a real id.
  const orgs = (list.data ?? []).filter((o): o is typeof o & { id: string } => Boolean(o.id));

  // Small N (platform admin view) — load each org's flags in parallel for the matrix.
  const flagsByOrg = new Map<string, Record<string, unknown>>();
  await Promise.all(
    orgs.map(async (org) => {
      const res = await getEntitlements(org.id).catch(() => null);
      flagsByOrg.set(org.id, res?.features ?? {});
    }),
  );

  return (
    <main>
      <h1>Organizations</h1>
      <p>
        <a href="/">← Home</a>
      </p>

      <section>
        <h2>Onboard an organization</h2>
        <form action={onboardOrgAction}>
          <p>
            <label>
              Name <input name="name" required placeholder="Acme Inc" />
            </label>
          </p>
          <p>
            <label>
              Admin email <input name="adminEmail" type="email" placeholder="admin@acme.com" />
            </label>
          </p>
          <p>
            <label>
              Template{' '}
              <select name="template" defaultValue="default">
                <option value="default">default</option>
                <option value="trial">trial</option>
                <option value="internal">internal</option>
              </select>
            </label>
          </p>
          <button type="submit">Onboard</button>
        </form>
      </section>

      <section>
        <h2>Tenants ({orgs.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Onboarding</th>
              <th>Entitlements</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => {
              const flags = flagsByOrg.get(org.id) ?? {};
              return (
                <tr key={org.id}>
                  <td>{org.name}</td>
                  <td>{org.status}</td>
                  <td>{org.onboarding_state}</td>
                  <td>
                    <form action={updateEntitlementsAction}>
                      <input type="hidden" name="orgId" value={org.id} />
                      {FEATURE_KEYS.map((key) => (
                        <label key={key} style={{ marginRight: '1rem' }}>
                          <input
                            type="checkbox"
                            name={`feature:${key}`}
                            defaultChecked={flags[key] === true}
                          />{' '}
                          {key}
                        </label>
                      ))}
                      <button type="submit">Save</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </main>
  );
}
