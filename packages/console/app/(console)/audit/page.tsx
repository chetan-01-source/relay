/**
 * Audit trail. The endpoint is a keyset-paginated feed (`limit` + a `before` sequence cursor) but the
 * console only ever read the first page, so anything older than the last 100 records was unreachable.
 * The cursor now lives in the URL, which keeps this a server component and makes each page linkable.
 *
 * Records are hash-chained: `seq` is contiguous and each row's `hash` covers its predecessor, so a
 * gap or an edited row breaks verification. Verification itself is an operator CLI
 * (`make audit-verify`) — deliberately not a console button, since the console is one of the systems
 * the trail exists to hold accountable.
 */
import Link from 'next/link';
import { requireOrg } from '../../lib/auth';
import { listAudit, listMembers, listApps, listRoutes, listProviders } from '../../lib/api';
import {
  memberNames,
  labelOf,
  appNames,
  routeNames,
  providerNames,
  auditTargetLabel,
} from '../../lib/labels';
import { LabelledId } from '../../../components/ui/labelled-id';
import { LocalTime } from '../../../components/local-time';
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

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

interface AuditPageProps {
  searchParams: Promise<{ before?: string }>;
}

export default async function AuditPage({ searchParams }: AuditPageProps) {
  const me = await requireOrg();
  const { before } = await searchParams;

  // The cursor is an exclusive upper bound on `seq`. Anything non-numeric is ignored rather than
  // forwarded — the gateway would 400, which reads to the user as a broken page.
  const cursor = Number(before);
  const query =
    Number.isInteger(cursor) && cursor > 0
      ? { limit: PAGE_SIZE, before: cursor }
      : { limit: PAGE_SIZE };

  // `actor` is recorded as the Logto subject, which is the right thing to store (ids are stable,
  // names are not) but unreadable on screen. Members are the only source that maps subject → person,
  // and that endpoint is platform-admin-only — so this resolves for admins and degrades to the raw
  // id for everyone else, rather than showing a spinner or an error for a nice-to-have.
  // Targets are ids too, and which map resolves one depends on the action — so the resources the
  // trail can point at come along for the ride.
  const [audit, members, apps, routes, providers] = await Promise.all([
    listAudit(query).catch(() => ({ data: [] })),
    me.is_platform_admin
      ? listMembers(me.org_id)
          .then((r) => r.data ?? [])
          .catch(() => [])
      : Promise.resolve([]),
    listApps()
      .then((r) => r.data ?? [])
      .catch(() => []),
    listRoutes()
      .then((r) => r.data ?? [])
      .catch(() => []),
    listProviders()
      .then((r) => r.data ?? [])
      .catch(() => []),
  ]);
  const rows = audit.data ?? [];
  const actors = memberNames(members);
  const targetMaps = {
    apps: appNames(apps),
    routes: routeNames(routes),
    providers: providerNames(providers),
  };
  // A full page means there is very likely another one; a short page is the end of the chain.
  const oldest = rows.at(-1)?.seq;
  const nextCursor = rows.length === PAGE_SIZE && typeof oldest === 'number' ? oldest : null;
  const isFirstPage = !(Number.isInteger(cursor) && cursor > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit trail</h1>
        <p className="text-sm text-muted-foreground">
          Every control-plane change, newest first. Hash-chained and verifiable with{' '}
          <code>make audit-verify</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{isFirstPage ? 'Recent activity' : 'Earlier activity'}</CardTitle>
          <CardDescription>
            {rows.length === 0
              ? 'Nothing in this range.'
              : `Sequence ${rows.at(-1)?.seq} → ${rows[0]?.seq} · ${rows.length} records.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No audit records{isFirstPage ? ' yet' : ' older than this point'}.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Seq</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Chain hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs tabular-nums">{r.seq}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <LocalTime iso={r.created_at} />
                    </TableCell>
                    <TableCell>
                      <LabelledId value={labelOf(actors, r.actor)} />
                    </TableCell>
                    <TableCell className="font-medium">{r.action}</TableCell>
                    <TableCell>
                      <LabelledId value={auditTargetLabel(r.action, r.target, targetMaps)} />
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs text-muted-foreground"
                      title={r.hash ?? undefined}
                    >
                      {r.hash ? `${r.hash.slice(0, 12)}…` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex items-center justify-between">
            {isFirstPage ? (
              <span />
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link href="/audit">Newest</Link>
              </Button>
            )}
            {nextCursor === null ? (
              <span className="text-xs text-muted-foreground">End of the trail.</span>
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link href={`/audit?before=${nextCursor}`}>Older records</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
