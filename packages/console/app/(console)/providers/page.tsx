import Link from 'next/link';
import { requireOrg, isOrgAdmin } from '../../lib/auth';
import { listProviders } from '../../lib/api';
import { healthTone } from '../../lib/providers';
import { CreateProviderForm } from '../../../components/create-provider-form';
import { DeleteProviderButton } from '../../../components/delete-provider-button';
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
import { Badge } from '../../../components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function ProvidersPage() {
  const me = await requireOrg();
  // Storing a credential swaps the key the org's traffic flows through, and the secret is
  // write-only — so it is an administrator's call. Members still see what is configured.
  const canManage = isOrgAdmin(me);
  const providers = await listProviders().catch(() => ({ data: [] }));
  const list = providers.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        <p className="text-sm text-muted-foreground">
          Upstream credentials. Secrets are sealed on save and never returned.
        </p>
      </div>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a credential</CardTitle>
            {/* Two different keys meet on this page and they are easy to confuse: the one you paste
              here is your upstream provider's, and it is write-only. The key your clients send to
              Relay is issued elsewhere — say so before someone waits for one that never appears. */}
            <CardDescription>
              This is your <strong>provider&rsquo;s</strong> API key (OpenAI, Anthropic, …). Relay
              seals it and never shows it again. It does <strong>not</strong> give you a Relay key —
              the <code>rk_live_…</code> key your clients send is issued from an{' '}
              <Link href="/apps" className="underline">
                application
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateProviderForm />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Adding or removing a provider credential requires an organization administrator. The
            credentials already configured are listed below.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your credentials</CardTitle>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No provider credentials yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Secret</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Routing health</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((p) => {
                  const health = healthTone(p.health_score);
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        <Link href={`/providers/${p.id}`} className="hover:underline">
                          {p.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{p.provider}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        …{p.last4}
                      </TableCell>
                      <TableCell>
                        <Badge variant={p.status === 'active' ? 'success' : 'secondary'}>
                          {p.status ?? 'unknown'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={health.variant}>{health.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage ? (
                          <DeleteProviderButton id={p.id as string} name={p.name as string} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
