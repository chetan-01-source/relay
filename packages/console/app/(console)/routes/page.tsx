/**
 * Routes editor — list + create (Day 13 · FE-1). Org-scoped; gated server-side by requireOrg (the
 * gateway enforces routes:read/write). Lists routes with their active-version summary and cache state;
 * the create form makes a route (optionally with an initial version built from provider credentials).
 */
import Link from 'next/link';
import { requireOrg } from '../../lib/auth';
import { listRoutes, listProviders, listApps } from '../../lib/api';
import { createRouteAction } from './actions';
import {
  AddVersionForm,
  type AppOption,
  type CredentialOption,
} from '../../../components/add-version-form';
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
import { Badge } from '../../../components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function RoutesPage() {
  await requireOrg();

  const [routes, providers, appsList] = await Promise.all([
    listRoutes().catch(() => ({ data: [] })),
    listProviders().catch(() => ({ data: [] })),
    listApps().catch(() => ({ data: [] })),
  ]);
  const list = routes.data ?? [];
  const apps: AppOption[] = (appsList.data ?? [])
    .filter((a): a is typeof a & { id: string } => Boolean(a.id))
    .map((a) => ({ id: a.id, name: a.name ?? a.id }));
  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const credentials: CredentialOption[] = (providers.data ?? [])
    .filter((p): p is typeof p & { id: string } => Boolean(p.id))
    .map((p) => ({ id: p.id, provider: p.provider ?? 'openai_compat', label: p.name ?? p.id }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Routes</h1>
        <p className="text-sm text-muted-foreground">
          Map a client-facing model to an ordered set of upstream targets. Rollback = activate an
          older version. A route applies to the whole organization unless it names an application,
          in which case it overrides the organization&rsquo;s route for that application only.
        </p>
      </div>

      <FeatureCard>
        <CardHeader>
          <CardTitle>New route</CardTitle>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add a{' '}
              <Link href="/providers" className="underline">
                provider credential
              </Link>{' '}
              first — a route needs at least one upstream target.
            </p>
          ) : (
            <AddVersionForm
              action={createRouteAction}
              credentials={credentials}
              apps={apps}
              showRouteFields
            />
          )}
        </CardContent>
      </FeatureCard>

      <Card>
        <CardHeader>
          <CardTitle>Routes ({list.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routes yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Applies to</TableHead>
                  <TableHead>Active version</TableHead>
                  <TableHead>Targets</TableHead>
                  <TableHead>Cache</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <Link href={`/routes/${r.id}`} className="hover:underline">
                        {r.model_name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.app_id ? (
                        <Badge variant="outline">{appName.get(r.app_id) ?? r.app_id}</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Organization</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.active_version ? `v${r.active_version} (${r.active_strategy})` : '—'}
                    </TableCell>
                    <TableCell>{r.target_count}</TableCell>
                    <TableCell>
                      <Badge variant={r.cache_enabled ? 'success' : 'secondary'}>
                        {r.cache_enabled ? 'on' : 'off'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/routes/${r.id}`}>Manage</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
