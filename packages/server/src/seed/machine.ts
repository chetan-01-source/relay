/**
 * Service-account seeding — the database half of `relay seed-machine`.
 *
 * Logto owns the credential (who this principal is and which org it belongs to); Relay owns what it
 * may DO inside that org. That split is deliberate and is enforced in
 * modules/identity/middleware/auth.ts: the org role is read from our `org_members` table rather than
 * trusted from a token claim, precisely so an identity provider cannot grant itself authority over
 * a tenant's money.
 *
 * Which is why granting a machine org-admin is a separate, explicit step. A service account only
 * ever needs it to write budgets or store provider credentials — the two operations that can spend
 * a tenant's money or redirect its traffic. Everything else (listing apps, issuing keys, reading
 * analytics) is scope-gated only, so the default is a service account that cannot do either.
 *
 * Ops script, not a request module — runs as the migration role (superuser, bypasses RLS) with
 * inline parametrized SQL, matching seed/demo.ts.
 */
import pg from 'pg';

export interface SeedMachineRequest {
  /** The Logto organization id (`organizations.logto_org_id`), as the token will carry it. */
  logtoOrgId: string;
  /** The machine application's client id — it lands in the token's `sub`, so it is the member id. */
  clientId: string;
  /** Grant organization-administrator rights, needed only for budget and provider writes. */
  admin: boolean;
}

export interface SeedMachineResult {
  /** Relay's own uuid for the organization. */
  orgId: string;
  orgName: string;
  role: 'admin' | 'member';
}

export async function seedMachine(
  databaseUrl: string,
  request: SeedMachineRequest,
): Promise<SeedMachineResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE logto_org_id = $1`,
      [request.logtoOrgId],
    );
    const org = rows[0];
    if (!org) {
      throw new Error(
        `No Relay organization for Logto org "${request.logtoOrgId}". ` +
          'Create the tenant in the console first — Relay rows are not implied by a Logto org.',
      );
    }

    const role = request.admin ? 'admin' : 'member';
    // Re-runnable, and re-runnable in BOTH directions: dropping --admin on a later run demotes the
    // account rather than silently leaving yesterday's grant in place.
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
      [org.id, request.clientId, role],
    );

    return { orgId: org.id, orgName: org.name, role };
  } finally {
    await client.end();
  }
}
