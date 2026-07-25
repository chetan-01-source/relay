import { requireOrg } from '../../lib/auth';
import { listAudit } from '../../lib/api';
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

export default async function AuditPage() {
  await requireOrg();
  const audit = await listAudit({ limit: 100 }).catch(() => ({ data: [] }));
  const rows = audit.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit trail</h1>
        <p className="text-sm text-muted-foreground">
          Every control-plane change, newest first. Hash-chained and verifiable.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>Up to 100 most recent records.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit records yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Seq</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.seq}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{r.actor}</TableCell>
                    <TableCell className="font-medium">{r.action}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.target ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
