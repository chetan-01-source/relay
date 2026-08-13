/**
 * Provider credential detail. `GET /api/v1/providers/{id}` has existed since the credential module
 * shipped but had no console surface, so three fields the gateway maintains — `status`, `base_url`
 * and the routing `health_score` — were invisible.
 *
 * The page also answers the question the list can't: which routes target this credential. Route
 * targets carry a `credential_id`, so the details are fetched in parallel and inverted (see
 * lib/providers.ts). That makes the delete an informed decision instead of a guess — deleting a
 * credential an active version still targets breaks that route at request time.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireOrg, isOrgAdmin } from '../../../lib/auth';
import { getProvider, listRoutes, getRoute, type RouteDetail } from '../../../lib/api';
import { usageOfCredential, healthTone } from '../../../lib/providers';
import { DeleteProviderButton } from '../../../../components/delete-provider-button';
import { LocalTime } from '../../../../components/local-time';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../../components/ui/table';
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireOrg();
  const canManage = isOrgAdmin(me);
  const { id } = await params;

  const provider = await getProvider(id).catch(() => null);
  if (!provider?.id) notFound();

  // Route targets are only exposed on the route *detail*, so the summaries are expanded in parallel.
  // An org holds a handful of routes, so this is a small fan-out; each failure degrades to "skipped"
  // rather than blanking the dependency table.
  const summaries = await listRoutes().catch(() => ({ data: [] }));
  const details = (
    await Promise.all(
      (summaries.data ?? []).map((route) =>
        route.id ? getRoute(route.id).catch(() => null) : Promise.resolve(null),
      ),
    )
  ).filter((route): route is RouteDetail => route !== null);

  const usage = usageOfCredential(details, provider.id);
  const health = healthTone(provider.health_score);
  const activeUsage = usage.filter((u) => u.isActive).length;

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: 'Provider', value: <Badge variant="outline">{provider.provider}</Badge> },
    {
      label: 'Status',
      value: (
        <Badge variant={provider.status === 'active' ? 'success' : 'secondary'}>
          {provider.status ?? 'unknown'}
        </Badge>
      ),
    },
    { label: 'Routing health', value: <Badge variant={health.variant}>{health.label}</Badge> },
    { label: 'Secret', value: <span className="font-mono text-sm">…{provider.last4}</span> },
    {
      label: 'Base URL',
      value: <span className="font-mono text-sm">{provider.base_url ?? 'provider default'}</span>,
    },
    {
      label: 'Created',
      value: <LocalTime iso={provider.created_at} className="text-sm text-muted-foreground" />,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/providers"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Providers
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{provider.name}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{provider.id}</p>
        </div>
        {canManage ? (
          <DeleteProviderButton id={provider.id} name={provider.name as string} />
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Credential</CardTitle>
          <CardDescription>
            The secret is sealed on write and never returned — only its last 4 characters are stored
            in the clear.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="flex items-center justify-between gap-3 border-b pb-2"
              >
                <dt className="text-sm text-muted-foreground">{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Routes using this credential</CardTitle>
          <CardDescription>
            {usage.length === 0
              ? 'Nothing targets it — deleting is safe.'
              : `${usage.length} target${usage.length === 1 ? '' : 's'}, ${activeUsage} on a live version. Deleting breaks those at request time.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usage.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No route targets this credential yet. Point one at it in the{' '}
              <Link href="/routes" className="underline">
                route editor
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Upstream model</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.map((entry) => (
                  <TableRow key={`${entry.routeId}-${entry.version}-${entry.model}`}>
                    <TableCell className="font-medium">
                      <Link href={`/routes/${entry.routeId}`} className="hover:underline">
                        {entry.modelName}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums">v{entry.version}</TableCell>
                    <TableCell className="font-mono text-sm">{entry.model}</TableCell>
                    <TableCell>
                      <Badge variant={entry.isActive ? 'success' : 'secondary'}>
                        {entry.isActive ? 'live' : 'inactive'}
                      </Badge>
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
