/**
 * Platform-admin tenancy console (Week 2 Day 7 · restyled Day 13) — onboard-org form + per-org
 * entitlement matrix. Lives inside the (console) shell; gated server-side by requireAdmin (the gateway
 * is still the real authority). Uses the Enterprise Gateway design system (docs/UI-THEME.md).
 */
import { requireAdmin } from '../../lib/auth';
import { listOrgs, getEntitlements } from '../../lib/api';
import { FEATURE_KEYS } from '../../lib/features';
import { onboardOrgAction, updateEntitlementsAction } from './actions';
import { FeatureCard } from '../../../components/ui/feature-card';
import { Card, CardHeader, CardTitle, CardContent } from '../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../components/ui/table';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Badge } from '../../../components/ui/badge';

export const dynamic = 'force-dynamic';

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export default async function OrgsPage() {
  await requireAdmin();

  const list = await listOrgs().catch(() => ({ data: [] }));
  const orgs = (list.data ?? []).filter((o): o is typeof o & { id: string } => Boolean(o.id));

  const flagsByOrg = new Map<string, Record<string, unknown>>();
  await Promise.all(
    orgs.map(async (org) => {
      const res = await getEntitlements(org.id).catch(() => null);
      flagsByOrg.set(org.id, res?.features ?? {});
    }),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
        <p className="text-sm text-muted-foreground">
          Onboard tenants and manage their entitlements. Platform-admin only.
        </p>
      </div>

      <FeatureCard className="max-w-2xl">
        <CardHeader>
          <CardTitle>Onboard an organization</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={onboardOrgAction} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="Acme Inc" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adminEmail">Admin email</Label>
              <Input id="adminEmail" name="adminEmail" type="email" placeholder="admin@acme.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template">Template</Label>
              <select id="template" name="template" defaultValue="default" className={selectClass}>
                <option value="default">default</option>
                <option value="trial">trial</option>
                <option value="internal">internal</option>
              </select>
            </div>
            <div className="flex items-end">
              <Button type="submit">Onboard organization</Button>
            </div>
          </form>
        </CardContent>
      </FeatureCard>

      <Card>
        <CardHeader>
          <CardTitle>Tenants ({orgs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {orgs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No organizations yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Onboarding</TableHead>
                  <TableHead>Entitlements</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((org) => {
                  const flags = flagsByOrg.get(org.id) ?? {};
                  return (
                    <TableRow key={org.id}>
                      <TableCell className="font-medium">{org.name}</TableCell>
                      <TableCell>
                        <Badge variant={org.status === 'active' ? 'success' : 'secondary'}>
                          {org.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {org.onboarding_state}
                      </TableCell>
                      <TableCell>
                        <form
                          action={updateEntitlementsAction}
                          className="flex flex-wrap items-center gap-4"
                        >
                          <input type="hidden" name="orgId" value={org.id} />
                          {FEATURE_KEYS.map((key) => (
                            <label
                              key={key}
                              className="flex items-center gap-1.5 text-xs text-muted-foreground"
                            >
                              <input
                                type="checkbox"
                                name={`feature:${key}`}
                                defaultChecked={flags[key] === true}
                                className="size-4 accent-primary"
                              />
                              {key}
                            </label>
                          ))}
                          <Button type="submit" variant="outline" size="sm">
                            Save
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
