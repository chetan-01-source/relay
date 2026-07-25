/**
 * Platform-admin cross-org dashboard (Day 13 · FE-1). Summarizes spend + requests across every tenant
 * from the platform analytics endpoint (`GET /api/v1/platform/analytics/usage`, keyed by org_id),
 * joined to org names via the tenancy list. Reads the hourly rollups only — never the hot path. Gated
 * server-side by requireAdmin; no new backend.
 */
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Activity, Building2, DollarSign } from 'lucide-react';
import { requireAdmin } from '../../lib/auth';
import { getPlatformUsage, listOrgs } from '../../lib/api';
import { labelOrgUsage, formatUsd } from '../../lib/usage';
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

export const dynamic = 'force-dynamic';

export default async function PlatformDashboardPage() {
  await requireAdmin();

  const [usage, orgList] = await Promise.all([
    getPlatformUsage().catch(() => null),
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
          <CardDescription>Highest spend first.</CardDescription>
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
