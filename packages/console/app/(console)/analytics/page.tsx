/**
 * Usage & spend report. The dashboard shows one fixed slice; this page exposes the whole analytics
 * surface the gateway offers — every `group_by` (model/app/route/day), an arbitrary `from`/`to`
 * window, and the CSV export (`format=csv`) that had no UI at all.
 *
 * State lives in the URL, not in React: the grouping is a link and the window is a GET form, so the
 * page stays a server component (no client bundle, no loading flash), every view is linkable, and
 * the browser Back button works. Reads are org-scoped and gated by requireOrg; the gateway still
 * enforces `analytics:read`.
 */
import Link from 'next/link';
import { Activity, Coins, DollarSign, Download, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { requireOrg } from '../../lib/auth';
import { getUsage, listApps, listRoutes } from '../../lib/api';
import { appNames, routeNames, bucketLabel } from '../../lib/labels';
import { LabelledId } from '../../../components/ui/labelled-id';
import { summarizeUsage, formatUsd, toDailySeries } from '../../lib/usage';
import {
  USAGE_GROUPINGS,
  parseGrouping,
  parseDate,
  defaultWindow,
  groupingColumn,
  exportHref,
  apiWindow,
} from '../../lib/analytics';
import { SpendChart } from '../../../components/spend-chart';
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
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { SegmentedNav } from '../../../components/ui/segmented-nav';

export const dynamic = 'force-dynamic';

/** Spread an optional href without tripping exactOptionalPropertyTypes. */
function hrefProp(href: string | undefined): { href?: string } {
  return href ? { href } : {};
}

interface AnalyticsPageProps {
  searchParams: Promise<{ group_by?: string; from?: string; to?: string }>;
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  await requireOrg();
  const params = await searchParams;

  const fallback = defaultWindow(new Date());
  const grouping = parseGrouping(params.group_by);
  const from = parseDate(params.from, fallback.from);
  const to = parseDate(params.to, fallback.to);
  // `from`/`to` stay inclusive for display; apiWindow converts the end into the exclusive bound the
  // endpoint uses, so the selected final day is actually included in the report.
  const range = apiWindow({ from, to });

  // The grouped report and the daily series are independent reads — fetch them together, and let
  // each fail on its own so an empty chart never blanks the table. Apps and routes come along so the
  // `app`/`route` bucket keys — which the API returns as bare ids — can be shown as names.
  const [grouped, daily, apps, routes] = await Promise.all([
    getUsage({ group_by: grouping, ...range }).catch(() => null),
    getUsage({ group_by: 'day', ...range }).catch(() => null),
    listApps().catch(() => ({ data: [] })),
    listRoutes().catch(() => ({ data: [] })),
  ]);

  const rows = grouped?.data ?? [];
  const totals = summarizeUsage(grouped);
  const series = toDailySeries(daily);
  const maps = { apps: appNames(apps.data ?? []), routes: routeNames(routes.data ?? []) };

  // The top-spend tile names the same bucket the table's first row does — resolved the same way, so
  // the two can't disagree.
  const topBucket = totals.topKey ? bucketLabel(grouping, totals.topKey, maps) : null;

  /** Where a bucket links to, when the grouping names a resource that has its own page. */
  const bucketHref = (key: string): string | undefined => {
    if (grouping === 'app') return `/apps/${key}`;
    if (grouping === 'route') return `/routes/${key}`;
    return undefined;
  };

  const tiles: { label: string; value: string; icon: LucideIcon }[] = [
    { label: 'Spend', value: formatUsd(totals.costUsd), icon: DollarSign },
    { label: 'Requests', value: totals.requests.toLocaleString(), icon: Activity },
    {
      label: 'Tokens',
      value: (totals.inputTokens + totals.outputTokens).toLocaleString(),
      icon: Coins,
    },
    // Named, not id'd — a tile reading "1604fdfa…" tells nobody which route is costing the most.
    { label: 'Top bucket', value: topBucket?.name ?? topBucket?.id ?? '—', icon: Sparkles },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usage &amp; spend</h1>
        <p className="text-sm text-muted-foreground">
          Grouped reporting over the hourly rollups, for any window. Dates are <strong>UTC</strong>,
          which is how the rollups are bucketed — a request just after local midnight can fall in
          the previous UTC day. Every view is a linkable URL.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 pt-6">
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Group by</span>
            <SegmentedNav
              label="Group usage by"
              options={USAGE_GROUPINGS.map((option) => ({
                label: option.label,
                // Carry the window across a grouping change — switching the axis should not silently
                // reset the dates the user just picked.
                href: `/analytics?group_by=${option.value}&from=${from}&to=${to}`,
                active: option.value === grouping,
              }))}
            />
          </div>

          <form method="get" action="/analytics" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="group_by" value={grouping} />
            <div className="space-y-1.5">
              <Label htmlFor="from">From (UTC)</Label>
              <Input id="from" name="from" type="date" defaultValue={from} className="w-40" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">To (UTC)</Label>
              <Input id="to" name="to" type="date" defaultValue={to} className="w-40" />
            </div>
            <Button type="submit" variant="outline">
              Apply
            </Button>
          </form>

          <Button asChild variant="outline">
            {/* A plain link, not fetch(): the browser handles the Content-Disposition download. */}
            {/* The href carries the INCLUSIVE dates, matching this page's URL; the export route
                handler applies the same apiWindow conversion before calling the gateway. */}
            <a href={exportHref('org', { group_by: grouping, from, to })} download>
              <Download aria-hidden="true" /> Export CSV
            </a>
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.label} className="transition-colors hover:border-primary/40">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>{tile.label}</CardDescription>
                <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <tile.icon className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <CardTitle className="truncate font-mono text-2xl tabular-nums">
                {tile.value}
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Spend over time</CardTitle>
          <CardDescription>
            Daily cost between {from} and {to} (UTC).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SpendChart series={series} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Breakdown by {groupingColumn(grouping).toLowerCase()}</CardTitle>
          <CardDescription>
            {rows.length} {rows.length === 1 ? 'bucket' : 'buckets'} · {from} → {to} (UTC)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No usage in this window. Widen the dates, or make a request from the{' '}
              <Link href="/playground" className="underline">
                playground
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupingColumn(grouping)}</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Input tokens</TableHead>
                  <TableHead className="text-right">Output tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((bucket) => (
                  <TableRow key={bucket.key}>
                    <TableCell>
                      <LabelledId
                        value={bucketLabel(grouping, bucket.key ?? '', maps)}
                        {...hrefProp(bucket.key ? bucketHref(bucket.key) : undefined)}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(bucket.requests ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(bucket.input_tokens ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(bucket.output_tokens ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatUsd(bucket.cost_usd ?? 0)}
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
