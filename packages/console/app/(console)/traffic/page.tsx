/**
 * Live-traffic page. Org-scoped; gated server-side by requireOrg. Two endpoints back it, and until
 * now only one had a surface: `GET /api/v1/traffic` (recent history, with a `status` filter) seeds
 * the table, and the SSE stream keeps it current. Seeding matters — an operator opening this page
 * after an incident wants the requests that already happened, not an empty table waiting on the next
 * one.
 *
 * The filter lives in the URL so it stays a server-side query (the gateway does the filtering, not
 * the browser) and each view is linkable.
 */
import { requireOrg } from '../../lib/auth';
import { listTraffic, listRoutes, listApps } from '../../lib/api';
import { routeNames, appNames } from '../../lib/labels';
import { parseStatus, TRAFFIC_STATUSES } from '../../lib/traffic';
import { LiveTraffic } from '../../../components/live-traffic';
import { Card, CardContent } from '../../../components/ui/card';
import { SegmentedNav } from '../../../components/ui/segmented-nav';

export const dynamic = 'force-dynamic';

const SEED_LIMIT = 50;

/** Human labels for the filter chips; the query value stays the gateway's enum member verbatim. */
const STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  error: 'Error',
  rate_limited: 'Rate limited',
  budget_exceeded: 'Budget exceeded',
};

interface TrafficPageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function TrafficPage({ searchParams }: TrafficPageProps) {
  await requireOrg();
  const params = await searchParams;
  const filter = parseStatus(params.status);

  // Routes and apps come along so the feed can name what each request hit. Resolved server-side and
  // handed over as plain objects — the table is a client component, so Maps would not survive.
  const [seed, routes, apps] = await Promise.all([
    listTraffic({ limit: SEED_LIMIT, ...(filter ? { status: filter } : {}) }).catch(() => ({
      data: [],
    })),
    listRoutes()
      .then((r) => r.data ?? [])
      .catch(() => []),
    listApps()
      .then((r) => r.data ?? [])
      .catch(() => []),
  ]);

  const filters = [
    { label: 'All', href: '/traffic', active: filter === null },
    ...TRAFFIC_STATUSES.map((status) => ({
      label: STATUS_LABELS[status] ?? status,
      href: `/traffic?status=${status}`,
      active: filter === status,
    })),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live traffic</h1>
        <p className="text-sm text-muted-foreground">
          Recent requests plus a live feed, newest first. Click a request id for its trace.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <SegmentedNav label="Filter by status" options={filters} />
          <LiveTraffic
            initialEvents={seed.data ?? []}
            filter={filter}
            routeNames={Object.fromEntries(routeNames(routes))}
            appNames={Object.fromEntries(appNames(apps))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
