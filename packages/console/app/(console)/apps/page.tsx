import Link from 'next/link';
import { requireOrg } from '../../lib/auth';
import { listApps } from '../../lib/api';
import { CreateAppForm } from '../../../components/create-app-form';
import { Card, CardHeader, CardTitle, CardContent } from '../../../components/ui/card';
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

export default async function AppsPage() {
  await requireOrg();
  const apps = await listApps().catch(() => ({ data: [] }));
  const list = apps.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        <p className="text-sm text-muted-foreground">
          An application groups the virtual keys your services use.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New application</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateAppForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your applications</CardTitle>
        </CardHeader>
        <CardContent>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No applications yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Keys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.description ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/apps/${a.id}`}>Manage keys</Link>
                      </Button>
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
