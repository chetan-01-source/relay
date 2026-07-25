/**
 * Live-traffic page (Day 13 · FE-1). Org-scoped; gated server-side by requireOrg. The table itself is
 * a client component fed by the SSE proxy — the request feed the gateway publishes as each request
 * settles (metering path). Reads the rollup-independent usage_events feed, never the hot path.
 */
import { requireOrg } from '../../lib/auth';
import { LiveTraffic } from '../../../components/live-traffic';
import { Card, CardContent } from '../../../components/ui/card';

export const dynamic = 'force-dynamic';

export default async function TrafficPage() {
  await requireOrg();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live traffic</h1>
        <p className="text-sm text-muted-foreground">
          Requests as they happen, newest first. Click a request id for its trace.
        </p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <LiveTraffic />
        </CardContent>
      </Card>
    </div>
  );
}
