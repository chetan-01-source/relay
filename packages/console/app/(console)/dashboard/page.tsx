import { Activity, CheckCircle2, Circle, Coins, DollarSign, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { requireOrg } from '../../lib/auth';
import { listApps, listKeys, listProviders, getUsage } from '../../lib/api';
import { summarizeUsage, formatUsd, toDailySeries } from '../../lib/usage';
import { SpendChart } from '../../../components/spend-chart';
import { buildChecklist, checklistProgress } from '../../lib/checklist';
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

export default async function DashboardPage() {
  await requireOrg();

  // Fetch everything the overview needs in parallel. Each call is independently tolerant so one empty
  // resource never blanks the whole page.
  const [apps, providers, usage, daily] = await Promise.all([
    listApps().catch(() => ({ data: [] })),
    listProviders().catch(() => ({ data: [] })),
    getUsage({ group_by: 'model' }).catch(() => null),
    getUsage({ group_by: 'day' }).catch(() => null),
  ]);

  const appList = apps.data ?? [];
  const keyLists = await Promise.all(
    appList.map((a) =>
      a.id ? listKeys(a.id).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
    ),
  );
  const keyCount = keyLists.reduce((n, k) => n + (k.data?.length ?? 0), 0);

  const totals = summarizeUsage(usage);
  const steps = buildChecklist({
    appCount: appList.length,
    keyCount,
    providerCount: providers.data?.length ?? 0,
    requestCount: totals.requests,
  });
  const progress = Math.round(checklistProgress(steps) * 100);
  const series = toDailySeries(daily);

  const tiles: { label: string; value: string; icon: LucideIcon }[] = [
    { label: 'Spend', value: formatUsd(totals.costUsd), icon: DollarSign },
    { label: 'Requests', value: totals.requests.toLocaleString(), icon: Activity },
    {
      label: 'Tokens',
      value: (totals.inputTokens + totals.outputTokens).toLocaleString(),
      icon: Coins,
    },
    { label: 'Top model', value: totals.topKey ?? '-', icon: Sparkles },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground">Spend and usage across your organization.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <CardHeader className="pb-2">
          <CardTitle>Spend over time</CardTitle>
          <CardDescription>Daily cost from the hourly usage rollups.</CardDescription>
        </CardHeader>
        <CardContent>
          <SpendChart series={series} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Setup</CardTitle>
            <CardDescription>{progress}% complete</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {steps.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                {s.done ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                <span className={s.done ? 'text-muted-foreground line-through' : ''}>
                  {s.label}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Spend by model</CardTitle>
            <CardDescription>From the hourly usage rollups.</CardDescription>
          </CardHeader>
          <CardContent>
            {usage && usage.data && usage.data.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.data.map((b) => (
                    <TableRow key={b.key}>
                      <TableCell className="font-medium">{b.key}</TableCell>
                      <TableCell className="text-right">
                        {(b.requests ?? 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">{formatUsd(b.cost_usd ?? 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No usage yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
