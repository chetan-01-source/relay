/**
 * Platform-admin cross-org dashboard (Day 13 · FE-1). Summarizes spend + requests across every tenant
 * from the platform analytics endpoint (`GET /api/v1/platform/analytics/usage`, keyed by org_id),
 * joined to org names via the tenancy list. Reads the hourly rollups only — never the hot path. Gated
 * server-side by requireAdmin; no new backend.
 */
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Activity, Building2, DollarSign, Download } from 'lucide-react';
import { requireAdmin } from '../../lib/auth';
import { getPlatformUsage, listOrgs } from '../../lib/api';
import { labelOrgUsage, formatUsd } from '../../lib/usage';
import { defaultWindow, parseDate, exportHref, apiWindow } from '../../lib/analytics';
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

export const dynamic = 'force-dynamic';

interface PlatformPageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function PlatformDashboardPage({ searchParams }: PlatformPageProps) {
  await requireAdmin();
  const params = await searchParams;

  const fallback = defaultWindow(new Date());
  const from = parseDate(params.from, fallback.from);
  const to = parseDate(params.to, fallback.to);

  // Inclusive for display, exclusive for the endpoint — same conversion as the org report.
  const [usage, orgList] = await Promise.all([
    getPlatformUsage(apiWindow({ from, to })).catch(() => null),
    listOrgs().catch(() => ({ data: [] })),
  ]);

  const names = new Map<string, string>();
  for (const o of orgList.data ?? []) {
    if (o.id) names.set(o.id, o.name ?? o.id);
  }

  const rows = labelOrgUsage(usage, names);
  const totalCost = rows.reduce((n, r) => n + r.costUsd, 0);
  const totalRequests = rows.reduce((n, r) => n + r.requests, 0);

  const tiles: { label: string; value: string; icon: LucideIcon }[] = [
    { label: 'Total spend', value: formatUsd(totalCost), icon: DollarSign },
    { label: 'Total requests', value: totalRequests.toLocaleString(), icon: Activity },
    { label: 'Active tenants', value: rows.length.toLocaleString(), icon: Building2 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform usage</h1>
        <p className="text-sm text-muted-foreground">
          Cross-org spend and requests from the hourly rollups. Platform-admin only.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-4 pt-6">
          <form method="get" action="/platform" className="flex flex-wrap items-end gap-3">
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
            <a href={exportHref('platform', { from, to })} download>
              <Download aria-hidden="true" /> Export CSV
            </a>
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.label} className="transition-colors hover:border-primary/40">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription>{t.label}</CardDescription>
                <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <t.icon className="h-4 w-4" />
                </span>
              </div>
              <CardTitle className="font-mono text-2xl tabular-nums">{t.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Spend by organization</CardTitle>
          <CardDescription>
            Highest spend first · {from} → {to} (UTC).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.orgId}>
                    <TableCell className="font-medium">
                      {names.has(r.orgId) ? (
                        <Link href={`/orgs/${r.orgId}`} className="hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                    </TableCell>
                    <TableCell className="text-right">{r.requests.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{formatUsd(r.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No usage across any org yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
