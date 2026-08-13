/**
 * Playground page — the server half. It resolves which client-facing model names this org can
 * actually reach (from its routes) so the form offers a pick list instead of a blank text field, and
 * hands off to the client component that owns the request/response state.
 *
 * The org's routes are the authority on what is callable: the data plane resolves the `model` field
 * against them, so a name that has no route can only ever 404.
 */
import Link from 'next/link';
import { requireOrg } from '../../lib/auth';
import { listRoutes } from '../../lib/api';
import { routedModelNames } from '../../lib/models';
import { Playground } from '../../../components/playground';
import { Card, CardContent } from '../../../components/ui/card';

export const dynamic = 'force-dynamic';

interface PlaygroundPageProps {
  searchParams: Promise<{ model?: string }>;
}

export default async function PlaygroundPage({ searchParams }: PlaygroundPageProps) {
  await requireOrg();
  const { model } = await searchParams;

  const routes = await listRoutes().catch(() => ({ data: [] }));
  const routedModels = [...routedModelNames(routes.data ?? [])].sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
        <p className="text-sm text-muted-foreground">
          Send a real request through the gateway with one of your virtual keys, and see the
          routing, cache and cost decisions it made.
        </p>
      </div>

      {routedModels.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No routes yet, so no model name resolves. Create one in the{' '}
              <Link href="/routes" className="underline">
                route editor
              </Link>{' '}
              first — you can still type a model name below if you know it.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Playground
        routedModels={routedModels}
        {...(model && routedModels.includes(model) ? { initialModel: model } : {})}
      />
    </div>
  );
}
