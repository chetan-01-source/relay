import { requireOrg } from '../../lib/auth';
import { listProviders } from '../../lib/api';
import { CreateProviderForm } from '../../../components/create-provider-form';
import { DeleteProviderButton } from '../../../components/delete-provider-button';
import { Card, CardHeader, CardTitle, CardContent } from '../../../components/ui/card';
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
  await requireOrg();
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

      <Card>
        <CardHeader>
          <CardTitle>Add a credential</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateProviderForm />
        </CardContent>
      </Card>

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
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{p.provider}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      …{p.last4}
                    </TableCell>
                    <TableCell className="text-right">
                      <DeleteProviderButton id={p.id as string} name={p.name as string} />
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
