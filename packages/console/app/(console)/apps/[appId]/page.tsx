import Link from 'next/link';
import { requireOrg } from '../../../lib/auth';
import { listApps, listKeys } from '../../../lib/api';
import { CreateKeyDialog } from '../../../../components/create-key-dialog';
import { KeyActions } from '../../../../components/key-actions';
import { SnippetDrawer } from '../../../../components/snippet-drawer';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../../components/ui/table';
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

const GATEWAY_URL = process.env.RELAY_API_BASE_URL ?? 'http://localhost:3000';

export default async function AppDetailPage({ params }: { params: Promise<{ appId: string }> }) {
  await requireOrg();
  const { appId } = await params;

  const [apps, keys] = await Promise.all([
    listApps().catch(() => ({ data: [] })),
    listKeys(appId).catch(() => ({ data: [] })),
  ]);
  const app = (apps.data ?? []).find((a) => a.id === appId);
  const keyList = keys.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/apps" className="text-sm text-muted-foreground hover:underline">
            ← Applications
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{app?.name ?? 'Application'}</h1>
        </div>
        <div className="flex gap-2">
          <SnippetDrawer baseUrl={GATEWAY_URL} apiKey="rk_live_…" />
          <CreateKeyDialog appId={appId} baseUrl={GATEWAY_URL} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Virtual keys</CardTitle>
        </CardHeader>
        <CardContent>
          {keyList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No keys yet. Create one to start making requests.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Env</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keyList.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      …{k.last4}
                    </TableCell>
                    <TableCell>{k.environment}</TableCell>
                    <TableCell>
                      <Badge variant={k.status === 'active' ? 'success' : 'secondary'}>
                        {k.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <KeyActions
                        keyId={k.id as string}
                        appId={appId}
                        status={(k.status as 'active' | 'revoked') ?? 'active'}
                        baseUrl={GATEWAY_URL}
                      />
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
