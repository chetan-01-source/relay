/**
 * Trace detail — everything the gateway recorded for one request id.
 *
 * A request can settle more than once (a cache hit and an upstream call share a trace id), so this is
 * a timeline, oldest first, with a roll-up across the whole trace at the top. Every id is resolved to
 * a name: reading "gpt-4o-mini via prod-openai on key …a1b2" is the point of the page, and the ids
 * stay visible underneath because that is what you paste into a log search.
 *
 * On what is NOT here: Relay does not retain prompt or completion bodies. `usage_events` stores
 * metadata only — ids, model, token counts, cost, status, latency. That is a deliberate default for a
 * gateway that sees every tenant's traffic: prompts routinely carry personal data and secrets, and
 * retaining them by default would make this table the most sensitive store in the system. Token
 * counts are shown instead, which is what billing and capacity questions actually need.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, Info } from 'lucide-react';
import { requireOrg } from '../../../lib/auth';
import { getTrace, listApps, listRoutes, listKeys, type TrafficEvent } from '../../../lib/api';
import { formatUsd } from '../../../lib/usage';
import { statusVariant } from '../../../lib/traffic';
import { appNames, routeNames, keyNames, labelOf } from '../../../lib/labels';
import { traceSummary } from '../../../lib/trace';
import { LabelledId } from '../../../../components/ui/labelled-id';
import { LocalTime } from '../../../../components/local-time';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  await requireOrg();
  const { requestId } = await params;

  const trace = await getTrace(requestId)
    .then((r) => r.data ?? [])
    .catch(() => []);
  if (trace.length === 0) notFound();

  const summary = traceSummary(trace);

  // Resolve the ids this trace references. Keys live under their application, so only the apps that
  // actually appear in the trace are expanded — no point listing keys for the whole org.
  const referencedApps = [
    ...new Set(trace.map((e) => e.app_id).filter((id): id is string => !!id)),
  ];
  const [apps, routes, keyLists] = await Promise.all([
    listApps()
      .then((r) => r.data ?? [])
      .catch(() => []),
    listRoutes()
      .then((r) => r.data ?? [])
      .catch(() => []),
    Promise.all(
      referencedApps.map((appId) =>
        listKeys(appId)
          .then((r) => r.data ?? [])
          .catch(() => []),
      ),
    ),
  ]);
  const maps = {
    apps: appNames(apps),
    routes: routeNames(routes),
    keys: keyNames(keyLists.flat()),
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/traffic"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Live traffic
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Request trace</h1>
          <Badge variant={statusVariant(summary.status)}>{summary.status}</Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{requestId}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Events" value={String(summary.events)} />
        <Stat label="Total cost" value={formatUsd(summary.costUsd)} mono />
        <Stat
          label="Tokens"
          value={`${summary.inputTokens.toLocaleString()} in / ${summary.outputTokens.toLocaleString()} out`}
        />
        <Stat
          label="Latency"
          value={summary.latencyMs != null ? `${summary.latencyMs.toLocaleString()}ms` : '—'}
          mono
        />
        <Stat label="Started" value={<LocalTime iso={summary.startedAt} />} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription>
            {summary.events === 1
              ? 'One settle event for this request.'
              : `${summary.events} settle events, oldest first — a cache hit and an upstream call share a trace id.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {summary.ordered.map((event, index) => (
            <TraceEvent
              key={event.id ?? index}
              event={event}
              index={index}
              total={summary.events}
              maps={maps}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex gap-3 pt-6">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Prompt and completion text is not stored.</p>
            <p>
              Relay records request <em>metadata</em> only — model, token counts, cost, status,
              latency and the ids above. Prompts routinely carry personal data and credentials, so
              retaining them by default is not something a shared gateway should do. Token counts
              answer the billing and capacity questions; if you need full payload capture for a
              specific application, that belongs behind an explicit, per-tenant opt-in.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface TraceEventProps {
  event: TrafficEvent;
  index: number;
  total: number;
  maps: {
    apps: ReadonlyMap<string, string>;
    routes: ReadonlyMap<string, string>;
    keys: ReadonlyMap<string, string>;
  };
}

function TraceEvent({ event, index, total, maps }: TraceEventProps) {
  const app = labelOf(maps.apps, event.app_id);
  const route = labelOf(maps.routes, event.route_id);
  const key = labelOf(maps.keys, event.key_id);

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {total > 1 ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
              {index + 1}
            </span>
          ) : null}
          <span className="font-medium">{event.model}</span>
          <span className="text-muted-foreground">via</span>
          <Badge variant="outline">{event.provider}</Badge>
        </div>
        <Badge variant={statusVariant(event.status ?? 'ok')}>{event.status}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Field label="Input tokens" value={(event.input_tokens ?? 0).toLocaleString()} mono />
        <Field label="Output tokens" value={(event.output_tokens ?? 0).toLocaleString()} mono />
        <Field label="Cost" value={formatUsd(event.cost_usd ?? 0)} mono />
        <Field
          label="Latency"
          value={event.latency_ms != null ? `${event.latency_ms.toLocaleString()}ms` : '—'}
          mono
        />

        <FieldNode label="Application">
          <LabelledId value={app} {...(app.id ? { href: `/apps/${app.id}` } : {})} />
        </FieldNode>
        <FieldNode label="Route">
          <LabelledId value={route} {...(route.id ? { href: `/routes/${route.id}` } : {})} />
        </FieldNode>
        <FieldNode label="Virtual key">
          <LabelledId value={key} />
        </FieldNode>
        <FieldNode label="Settled at">
          <LocalTime iso={event.created_at} className="font-medium" />
        </FieldNode>
      </dl>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <FieldNode label={label}>
      <span className={mono ? 'font-mono tabular-nums' : 'font-medium'}>{value}</span>
    </FieldNode>
  );
}

function FieldNode({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`text-base ${mono ? 'font-mono tabular-nums' : ''}`}>
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
