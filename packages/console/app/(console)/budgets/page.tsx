/**
 * Budgets — the write side of what the data plane enforces.
 *
 * Two scopes, and they compose rather than override: a request must fit inside its application's
 * ceiling AND its organization's. Setting an app ceiling does not lift the org one, which is the
 * whole point — the org cap is the backstop.
 *
 * Spend comes from the usage rollups, the same source as Usage & spend, so the two screens agree.
 * Enforcement counts against Valkey on the hot path — a different mechanism for a different job
 * (atomic, per-request); this view is the durable record.
 *
 * Everything here is UTC and says so. The rollups are bucketed by UTC hour and the enforcement
 * window is the UTC calendar day/month, so labelling it anything else would be a lie — a request at
 * 00:05 IST counts against the previous UTC day, and the operator needs to be able to see why.
 */
import Link from 'next/link';
import { Building2, Boxes } from 'lucide-react';
import { requireOrg, isOrgAdmin } from '../../lib/auth';
import { listBudgets, listApps, getUsage } from '../../lib/api';
import { summarizeUsage } from '../../lib/usage';
import { apiWindow } from '../../lib/analytics';
import { BUDGET_PERIODS, periodWindow, budgetFor, filterApps } from '../../lib/budget';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { BudgetScopeRow } from '../../../components/budget-scope';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../../../components/ui/card';

export const dynamic = 'force-dynamic';

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string }>;
}) {
  const me = await requireOrg();
  const canEdit = isOrgAdmin(me);
  const now = new Date();
  const appQuery = (await searchParams).app ?? '';

  const [budgets, allApps] = await Promise.all([
    listBudgets()
      .then((r) => r.data ?? [])
      .catch(() => []),
    listApps()
      .then((r) => r.data ?? [])
      .catch(() => []),
  ]);

  // Filtered for display only: spend below is still computed over every application, so the totals
  // do not change depending on what is typed in the search box.
  const apps = filterApps(allApps, appQuery);

  // Org spend per period, over that period's own window — a monthly ceiling counts from the 1st, a
  // daily one counts today, and a rolling window would report against the wrong total.
  const orgSpend = await Promise.all(
    BUDGET_PERIODS.map((period) =>
      getUsage(apiWindow(periodWindow(period, now)))
        .then((usage) => summarizeUsage(usage).costUsd)
        .catch(() => 0),
    ),
  );

  // Per-application spend for the same windows, grouped by app so one read covers every application.
  const appSpend = await Promise.all(
    BUDGET_PERIODS.map((period) =>
      getUsage({ group_by: 'app', ...apiWindow(periodWindow(period, now)) })
        .then((usage) => {
          const byApp = new Map<string, number>();
          for (const bucket of usage.data ?? []) {
            if (bucket.key) byApp.set(bucket.key, bucket.cost_usd ?? 0);
          }
          return byApp;
        })
        .catch(() => new Map<string, number>()),
    ),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Budgets</h1>
        <p className="text-sm text-muted-foreground">
          Spend ceilings for your organization and for individual applications. A request must fit
          inside both. Changes reach the data plane within about a second.
        </p>
        {canEdit ? null : (
          <p className="mt-2 text-sm text-muted-foreground">
            You have read access to budgets. Changing a ceiling requires an organization
            administrator.
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Organization
          </CardTitle>
          <CardDescription>
            Applies to everything this organization sends, whichever application it came from.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          {BUDGET_PERIODS.map((period, index) => {
            const budget = budgetFor(budgets, period, null);
            return (
              <BudgetScopeRow
                key={period}
                period={period}
                limitUsd={typeof budget?.limit_usd === 'number' ? budget.limit_usd : null}
                hardCutoff={budget?.hard_cutoff ?? true}
                spentUsd={orgSpend[index] ?? 0}
                window={periodWindow(period, now)}
                canEdit={canEdit}
              />
            );
          })}
        </CardContent>
      </Card>

      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Applications
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A per-application ceiling caps one application without touching the others. The
          organization ceiling above still applies on top.
        </p>
      </div>

      {/* A GET form, so the filter lands in the URL: the view is shareable, survives a reload, and
          the Back button works — the same convention the analytics page uses. */}
      {allApps.length > 3 ? (
        <form className="flex gap-2" method="GET">
          <Input
            type="search"
            name="app"
            defaultValue={appQuery}
            placeholder="Filter applications by name or id…"
            className="max-w-sm"
            aria-label="Filter applications"
          />
          <Button type="submit" variant="secondary" size="sm">
            Filter
          </Button>
          {appQuery ? (
            <Link
              href="/budgets"
              className="self-center text-sm text-muted-foreground hover:underline"
            >
              Clear
            </Link>
          ) : null}
        </form>
      ) : null}

      {allApps.length > 0 && apps.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">No application matches “{appQuery}”.</p>
          </CardContent>
        </Card>
      ) : null}

      {allApps.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No applications yet. Create one in{' '}
              <Link href="/apps" className="underline">
                Applications
              </Link>{' '}
              to give it its own ceiling.
            </p>
          </CardContent>
        </Card>
      ) : (
        apps.map((app) => (
          <Card key={app.id}>
            <CardHeader>
              <CardTitle className="text-base">
                <Link href={`/apps/${app.id}`} className="hover:underline">
                  {app.name}
                </Link>
              </CardTitle>
              <CardDescription className="font-mono text-xs">{app.id}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              {BUDGET_PERIODS.map((period, index) => {
                const budget = budgetFor(budgets, period, app.id ?? null);
                return (
                  <BudgetScopeRow
                    key={period}
                    period={period}
                    limitUsd={typeof budget?.limit_usd === 'number' ? budget.limit_usd : null}
                    hardCutoff={budget?.hard_cutoff ?? true}
                    spentUsd={appSpend[index]?.get(app.id ?? '') ?? 0}
                    window={periodWindow(period, now)}
                    appId={app.id ?? null}
                    canEdit={canEdit}
                  />
                );
              })}
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Rejections appear as <code>budget_exceeded</code> in{' '}
          <Link href="/traffic?status=budget_exceeded" className="underline">
            Live traffic
          </Link>
          , and every change is recorded in the{' '}
          <Link href="/audit" className="underline">
            audit trail
          </Link>{' '}
          with the previous value. Periods are UTC calendar windows: a daily ceiling resets at 00:00
          UTC, a monthly one on the 1st.
        </CardContent>
      </Card>
    </div>
  );
}
