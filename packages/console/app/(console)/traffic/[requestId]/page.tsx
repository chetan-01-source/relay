/**
 * Trace detail (Day 13 · FE-1). All usage events sharing a request/trace id (a request may be metered
 * more than once, e.g. a cache hit plus the upstream call). Org-scoped; gated by requireOrg.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireOrg } from '../../../lib/auth';
import { getTrace } from '../../../lib/api';
import { formatUsd } from '../../../lib/usage';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

function statusVariant(status: string): 'success' | 'destructive' | 'secondary' {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'destructive';
  return 'secondary';
}

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

  const totalCost = trace.reduce((n, e) => n + (e.cost_usd ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/traffic"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="mr-1 h-4 w-4" /> Live traffic
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Trace</h1>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{requestId}</p>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-muted-foreground">
          Events: <span className="font-medium text-foreground">{trace.length}</span>
        </span>
        <span className="text-muted-foreground">
          Total cost: <span className="font-medium text-foreground">{formatUsd(totalCost)}</span>
        </span>
      </div>

      {trace.map((e) => (
        <Card key={e.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {e.provider} · {e.model}
              <Badge variant={statusVariant(e.status ?? 'ok')}>{e.status}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <Field label="Input tokens" value={String(e.input_tokens ?? 0)} />
              <Field label="Output tokens" value={String(e.output_tokens ?? 0)} />
              <Field label="Cost" value={formatUsd(e.cost_usd ?? 0)} />
              <Field label="Latency" value={e.latency_ms != null ? `${e.latency_ms}ms` : '—'} />
              <Field label="App" value={e.app_id ?? '—'} mono />
              <Field label="Route" value={e.route_id ?? '—'} mono />
              <Field label="Key" value={e.key_id ?? '—'} mono />
              <Field label="At" value={new Date(e.created_at ?? '').toLocaleString()} />
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-xs' : 'font-medium'}>{value}</dd>
    </div>
  );
}
