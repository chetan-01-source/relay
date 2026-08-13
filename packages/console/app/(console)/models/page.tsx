/**
 * Model catalogue. `GET /v1/models` is an OpenAI-compatible discovery endpoint that had no console
 * surface at all — clients could only find it by reading the spec. It is unauthenticated by design,
 * so this page carries no bearer for it.
 *
 * The catalogue alone doesn't answer the question an operator actually has ("can I call this?"), so
 * it is joined against the org's routes: a catalogue entry is only reachable once a route claims that
 * client-facing model name. Unroutable entries get a one-click path to the route editor.
 */
import Link from 'next/link';
import { Boxes, Waypoints } from 'lucide-react';
import { requireOrg } from '../../lib/auth';
import { listModels, listRoutes } from '../../lib/api';
import { groupByOwner, routedModelNames } from '../../lib/models';
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

export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  await requireOrg();

  const [catalogue, routes] = await Promise.all([
    listModels().catch(() => ({ data: [] })),
    listRoutes().catch(() => ({ data: [] })),
  ]);

  const groups = groupByOwner(catalogue.data ?? []);
  const routed = routedModelNames(routes.data ?? []);
  const total = (catalogue.data ?? []).length;
  const reachable = (catalogue.data ?? []).filter((m) => m.id && routed.has(m.id)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground">
            The deployment&rsquo;s catalogue, as served by <code>GET /v1/models</code>. A model is
            callable once one of your routes claims its name.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/routes">
            <Waypoints aria-hidden="true" /> Manage routes
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Catalogue</CardDescription>
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Boxes className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <CardTitle className="font-mono text-2xl tabular-nums">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription>Routable by your org</CardDescription>
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Waypoints className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <CardTitle className="font-mono text-2xl tabular-nums">{reachable}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              The catalogue is empty — this deployment has no seeded models. Run{' '}
              <code>make seed-demo</code> against the stack to populate it.
            </p>
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.owner}>
            <CardHeader>
              <CardTitle className="capitalize">{group.owner}</CardTitle>
              <CardDescription>
                {group.models.length} {group.models.length === 1 ? 'model' : 'models'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model id</TableHead>
                    <TableHead>Owned by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.models.map((model) => {
                    const isRouted = !!model.id && routed.has(model.id);
                    return (
                      <TableRow key={model.id}>
                        <TableCell className="font-mono text-sm font-medium">{model.id}</TableCell>
                        <TableCell className="text-muted-foreground">{model.owned_by}</TableCell>
                        <TableCell>
                          <Badge variant={isRouted ? 'success' : 'secondary'}>
                            {isRouted ? 'routable' : 'no route'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {isRouted ? (
                            <Button asChild variant="ghost" size="sm">
                              <Link
                                href={`/playground?model=${encodeURIComponent(model.id ?? '')}`}
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
        ))
      )}
    </div>
  );
}
