import { Activity, Database, Zap, Flame, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { requireAdmin } from '../../lib/auth';
import { getGatewayHealth } from '../../lib/health';
import { FeatureCard } from '../../../components/ui/feature-card';
import { CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';

// Live operational signal — never cache it.
export const dynamic = 'force-dynamic';

/**
 * System status (Day 14, operability). A platform-admin read of the gateway's internal /readyz probe:
 * overall readiness plus each dependency (Postgres, Valkey, snapshot warm). Read-only — the console
 * shows health, it never mutates it — so this is the natural home for the operability surface added by
 * the graceful-shutdown/readiness work. Follows UI-THEME: blue accent, square FeatureCard for the
 * emphasis panel, plain Cards for the component grid, no motion beyond color transitions.
 */
export default async function StatusPage() {
  await requireAdmin();
  const health = await getGatewayHealth();

  const overall = !health.reachable
    ? { label: 'Unreachable', tone: 'error' as const }
    : health.status === 'ready'
      ? { label: 'Ready', tone: 'ok' as const }
      : { label: 'Degraded', tone: 'warn' as const };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="text-sm text-muted-foreground">
          Live readiness of the gateway and its dependencies, read from the internal probe.
        </p>
      </div>

      <FeatureCard className="p-6">
        <div className="flex items-center gap-4">
          <StatusGlyph tone={overall.tone} />
          <div className="min-w-0">
            <div className="text-lg font-semibold">Gateway {overall.label.toLowerCase()}</div>
            <p className="text-sm text-muted-foreground">
              {health.reachable
                ? 'The gateway responded to the readiness probe.'
                : `Could not reach the gateway at ${health.endpoint}. Confirm it is running and RELAY_INTERNAL_URL is correct.`}
            </p>
          </div>
          <div className="ml-auto shrink-0 text-right">
            <div className="font-mono text-sm tabular-nums">{health.version ?? '—'}</div>
            <div className="text-xs text-muted-foreground">version</div>
          </div>
        </div>
      </FeatureCard>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <HealthTile
          icon={Database}
          name="Postgres"
          detail="Tenant data, RLS-isolated"
          up={health.pg}
          reachable={health.reachable}
        />
        <HealthTile
          icon={Zap}
          name="Valkey"
          detail="Rate limits, cache, live counters"
          up={health.valkey}
          reachable={health.reachable}
        />
        <HealthTile
          icon={Flame}
          name="Snapshot warm"
          detail="Worker wired & serving (drains on shutdown)"
          up={health.warm}
          reachable={health.reachable}
        />
      </div>
    </div>
  );
}

function StatusGlyph({ tone }: { tone: 'ok' | 'warn' | 'error' }) {
  const map = {
    ok: { Icon: CheckCircle2, cls: 'bg-primary/10 text-primary' },
    warn: { Icon: AlertTriangle, cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-500' },
    error: { Icon: XCircle, cls: 'bg-destructive/10 text-destructive' },
  }[tone];
  return (
    <span className={`flex size-11 shrink-0 items-center justify-center rounded-md ${map.cls}`}>
      <map.Icon className="size-5" aria-hidden />
    </span>
  );
}

function HealthTile({
  icon: Icon,
  name,
  detail,
  up,
  reachable,
}: {
  icon: LucideIcon;
  name: string;
  detail: string;
  up: boolean | undefined;
  reachable: boolean;
}) {
  // Unknown (gateway unreachable) is a distinct, honest state — not a silent "down".
  const state = !reachable ? 'unknown' : up ? 'up' : 'down';
  const badge = {
    up: { variant: 'success' as const, text: 'Healthy' },
    down: { variant: 'destructive' as const, text: 'Down' },
    unknown: { variant: 'secondary' as const, text: 'Unknown' },
  }[state];

  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <span className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="size-4" aria-hidden />
          </span>
          <CardTitle className="text-base">{name}</CardTitle>
        </span>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </CardHeader>
      <CardContent>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Activity className="size-3.5" aria-hidden />
          {detail}
        </p>
      </CardContent>
    </Card>
  );
}
