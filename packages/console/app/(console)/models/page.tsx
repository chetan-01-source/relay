/**
 * Model catalogue — every model the deployment knows about upstream, searchable.
 *
 * This page used to read `GET /v1/models`, which answers a DIFFERENT question: "what may a virtual
 * key call", i.e. the org's route aliases. With four routes configured it listed four rows, so the
 * one thing an operator comes here to do — find a model id and copy it into a route target — was
 * impossible. It now reads the catalogue (`GET /api/v1/catalog/models`, 500+ entries once synced)
 * and marks which of them a route already claims.
 *
 * Search state lives in the URL rather than in React, matching the analytics and budgets pages: the
 * view is shareable, survives a reload, and the Back button works.
 */
import Link from 'next/link';
import { Boxes, Waypoints } from 'lucide-react';
import { requireOrg } from '../../lib/auth';
import { searchCatalog, listRoutes } from '../../lib/api';
import { routedModelNames } from '../../lib/models';
import { groupByProvider } from '../../lib/catalog';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../components/ui/table';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { CopyButton } from '../../../components/copy-button';
import { PROVIDERS } from 'relay-shared';

export const dynamic = 'force-dynamic';

/** Enough to browse a provider's full family without turning the page into a scroll marathon. */
const PAGE_LIMIT = 200;

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; provider?: string }>;
}) {
  await requireOrg();

  const params = await searchParams;
  const query = params.q ?? '';
  const provider = params.provider ?? '';

  const [catalogue, routes] = await Promise.all([
    searchCatalog({
      ...(provider ? { provider } : {}),
      ...(query ? { q: query } : {}),
      limit: PAGE_LIMIT,
    }).catch(() => ({ data: [], counts: {} })),
    listRoutes().catch(() => ({ data: [] })),
  ]);

  const models = catalogue.data ?? [];
  const counts = (catalogue.counts ?? {}) as Record<string, number>;
  const routed = routedModelNames(routes.data ?? []);
  const groups = groupByProvider(models);
  const catalogued = Object.values(counts).reduce((sum, n) => sum + n, 0);
  // The result set is capped, so say so rather than letting the page imply the catalogue ends here.
  const truncated = models.length >= PAGE_LIMIT;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground">
            Every model this deployment knows upstream. Copy an id to use it as a route target — a
            model becomes callable once one of your routes claims a name for it.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/routes">
            <Waypoints aria-hidden="true" /> Manage routes
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form className="flex flex-wrap items-end gap-2" method="GET">
            <div className="min-w-[16rem] flex-1 space-y-1.5">
              <label className="text-sm" htmlFor="model-search">
                Search
              </label>
              <Input
                id="model-search"
                type="search"
                name="q"
                defaultValue={query}
                placeholder="claude, gpt-4o, llama…"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="model-provider">
                Provider
              </label>
              <select
                id="model-provider"
                name="provider"
                defaultValue={provider}
                className="flex h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">All providers</option>
                {PROVIDERS.filter((p) => (counts[p.id] ?? 0) > 0).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({counts[p.id]})
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {query || provider ? (
              <Button asChild variant="ghost">
                <Link href="/models">Clear</Link>
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Catalogued</CardDescription>
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Boxes className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <CardTitle className="font-mono text-2xl tabular-nums">{catalogued}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Showing</CardDescription>
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Waypoints className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <CardTitle className="font-mono text-2xl tabular-nums">{models.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {catalogued === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              The catalogue is empty. Run <code>make sync-models</code> to fill it from your
              providers — it reads each one&rsquo;s model list using the credentials you have
              already stored, and makes no completion requests.
            </p>
          </CardContent>
        </Card>
      ) : models.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No model matches that search.{' '}
              <Link href="/models" className="underline">
                Clear the filters
              </Link>{' '}
              to see all {catalogued}.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {truncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {PAGE_LIMIT} matches — narrow the search to see the rest.
            </p>
          ) : null}

          {groups.map((group) => (
            <Card key={group.provider}>
              <CardHeader>
                <CardTitle className="capitalize">{group.label}</CardTitle>
                <CardDescription>
                  {group.models.length} {group.models.length === 1 ? 'model' : 'models'}
                  {counts[group.provider] && counts[group.provider] !== group.models.length
                    ? ` of ${counts[group.provider]}`
                    : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model id</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.models.map((model) => {
                      const isRouted = !!model.model && routed.has(model.model);
                      return (
                        <TableRow key={`${group.provider}:${model.model}`}>
                          <TableCell className="font-mono text-sm font-medium">
                            <span className="flex items-center gap-2">
                              {model.model}
                              {/* The point of the page: get this id into a route target. */}
                              <CopyButton value={model.model ?? ''} />
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant={isRouted ? 'success' : 'secondary'}>
                              {isRouted ? 'routable' : 'no route'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {isRouted ? (
                              <Button asChild variant="ghost" size="sm">
                                <Link
                                  href={`/playground?model=${encodeURIComponent(model.model ?? '')}`}
                                >
                                  Try it
                                </Link>
                              </Button>
                            ) : (
                              <Button asChild variant="ghost" size="sm">
                                <Link href="/routes">Add a route</Link>
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
