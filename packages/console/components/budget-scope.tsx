/**
 * One scope's ceilings — the org's, or one application's — rendered as a period card each.
 *
 * Both scopes render identically on purpose: an application ceiling and an org ceiling behave the
 * same way, they just bind different traffic. Sharing the component is what keeps that true on
 * screen as well as in the enforcement path.
 */
import { TriangleAlert } from 'lucide-react';
import { formatUsd } from '../app/lib/usage';
import { PERIOD_LABEL, budgetStatus } from '../app/lib/budget';
import type { BudgetPeriod } from '../app/lib/api';
import { BudgetForm } from './budget-form';
import { Badge } from './ui/badge';

export interface BudgetScopeRowProps {
  period: BudgetPeriod;
  /** Current ceiling for this scope+period, or null when none is set. */
  limitUsd: number | null;
  hardCutoff: boolean;
  /** Spend in the period's own window, from the usage rollups. */
  spentUsd: number;
  /** Inclusive UTC window the spend covers. */
  window: { from: string; to: string };
  appId?: string | null;
  /** False renders the ceiling read-only — a member sees the number, an admin can move it. */
  canEdit?: boolean;
}

export function BudgetScopeRow({
  period,
  limitUsd,
  hardCutoff,
  spentUsd,
  window,
  appId = null,
  canEdit = true,
}: BudgetScopeRowProps) {
  const status = budgetStatus(spentUsd, limitUsd ?? 0);

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{PERIOD_LABEL[period]}</p>
          <p className="text-xs text-muted-foreground">
            {period === 'daily'
              ? `${window.to} · UTC day`
              : `${window.from} → ${window.to} · UTC month to date`}
          </p>
        </div>
        {limitUsd === null ? (
          <Badge variant="secondary">not set</Badge>
        ) : (
          <Badge variant={hardCutoff ? 'success' : 'outline'}>
            {hardCutoff ? 'enforcing' : 'tracking only'}
          </Badge>
        )}
      </div>

      {limitUsd === null ? (
        <p className="text-sm text-muted-foreground">
          No ceiling — spend is unlimited here. Spent so far:{' '}
          <span className="font-mono">{formatUsd(spentUsd)}</span>.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-mono tabular-nums">
              {formatUsd(spentUsd)}{' '}
              <span className="text-muted-foreground">of {formatUsd(limitUsd)}</span>
            </span>
            <span
              className={
                status.tone === 'over'
                  ? 'font-medium text-destructive'
                  : status.tone === 'warn'
                    ? 'font-medium text-amber-600'
                    : 'text-muted-foreground'
              }
            >
              {status.percent}% used · {formatUsd(status.remainingUsd)} left
            </span>
          </div>
          {/* Width is the clamped percent so an over-budget bar stays inside its track; the true
              overage is carried by the copy and the tone. */}
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={status.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${PERIOD_LABEL[period]} budget used`}
          >
            <div
              className={`h-full transition-colors ${
                status.tone === 'over'
                  ? 'bg-destructive'
                  : status.tone === 'warn'
                    ? 'bg-amber-500'
                    : 'bg-primary'
              }`}
              style={{ width: `${status.percent}%` }}
            />
          </div>

          {status.tone === 'over' ? (
            hardCutoff ? (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                Over the ceiling — requests are rejected with <code>budget_exceeded</code>.
              </p>
            ) : (
              <p className="text-sm text-amber-600">
                Over the ceiling, but requests are not blocked — this budget only tracks.
              </p>
            )
          ) : null}
        </div>
      )}

      {canEdit ? (
        <BudgetForm period={period} limitUsd={limitUsd} hardCutoff={hardCutoff} appId={appId} />
      ) : (
        <p className="text-xs text-muted-foreground">
          Only an organization administrator can change this ceiling.
        </p>
      )}
    </div>
  );
}
