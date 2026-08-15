/**
 * Routes editor — detail (Day 13 · FE-1). One route's versions + targets, with activate/rollback, a
 * cache toggle, delete, and an add-version form. Capability-lint: a target whose (provider, model) is
 * absent from the model catalog gets a warning badge. Gated server-side by requireOrg.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, AlertTriangle } from 'lucide-react';
import { requireOrg } from '../../../lib/auth';
import { getRoute, listProviders } from '../../../lib/api';
import { providerNames, labelOf } from '../../../lib/labels';
import { LabelledId } from '../../../../components/ui/labelled-id';
import {
  addVersionAction,
  activateVersionAction,
  toggleCacheAction,
  deleteRouteAction,
} from '../actions';
import { AddVersionForm, type CredentialOption } from '../../../../components/add-version-form';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../../../../components/ui/card';
import { FeatureCard } from '../../../../components/ui/feature-card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../../components/ui/table';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function RouteDetailPage({
  params,
}: {
  params: Promise<{ routeId: string }>;
}) {
  await requireOrg();
  const { routeId } = await params;

  const route = await getRoute(routeId).catch(() => null);
  if (!route?.id) notFound();
  const providers = await listProviders().catch(() => ({ data: [] }));
  const credentials: CredentialOption[] = (providers.data ?? [])
    .filter((p): p is typeof p & { id: string } => Boolean(p.id))
    .map((p) => ({ id: p.id, provider: p.provider ?? 'openai_compat', label: p.name ?? p.id }));

  const credentialNames = providerNames(providers.data ?? []);
  const versions = route.versions ?? [];

  // What is serving traffic right now. Seeds the update form so an edit starts from reality rather
  // than from a blank row — the previous behaviour, which made "add a fallback" mean retyping every
  // target and is why these routes ended up with exactly one.
  const activeTargets = (versions.find((v) => v.is_active)?.targets ?? []).map((target) => ({
    credential_id: target.credential_id ?? '',
    model: target.model ?? '',
    priority: target.priority ?? 100,
    weight: target.weight ?? 1,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/routes"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="mr-1 h-4 w-4" /> Routes
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{route.model_name}</h1>
          <Badge variant={route.cache_enabled ? 'success' : 'secondary'}>
            cache {route.cache_enabled ? 'on' : 'off'}
          </Badge>
        </div>
        {/* The id is what appears in traces, usage buckets and audit rows — keep it copyable here so
            this page can be reached from, and matched back to, any of them. */}
        <p className="mt-1 font-mono text-xs text-muted-foreground">{route.id}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form action={toggleCacheAction}>
          <input type="hidden" name="routeId" value={route.id} />
          <input type="hidden" name="enabled" value={route.cache_enabled ? 'false' : 'true'} />
          <Button type="submit" variant="outline" size="sm">
            {route.cache_enabled ? 'Disable cache' : 'Enable cache'}
          </Button>
        </form>
        <form action={deleteRouteAction}>
          <input type="hidden" name="routeId" value={route.id} />
          <Button type="submit" variant="destructive" size="sm">
            Delete route
          </Button>
        </form>
      </div>

      <div className="space-y-4">
        {versions.map((v) => (
          <Card key={v.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  Version {v.version}
                  <span className="text-xs font-normal text-muted-foreground">({v.strategy})</span>
                  {v.is_active ? <Badge variant="success">active</Badge> : null}
                </CardTitle>
                {!v.is_active ? (
                  <form action={activateVersionAction}>
                    <input type="hidden" name="routeId" value={route.id} />
                    <input type="hidden" name="versionId" value={v.id} />
                    <Button type="submit" variant="outline" size="sm">
                      Activate
                    </Button>
                  </form>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {(v.targets ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No targets.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Credential</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Priority</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(v.targets ?? []).map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>{t.provider}</TableCell>
                        {/* Which credential, not just which vendor — two OpenAI keys are otherwise
                            indistinguishable here, and they can have different quotas and health. */}
                        <TableCell>
                          <LabelledId
                            value={labelOf(credentialNames, t.credential_id)}
                            {...(t.credential_id ? { href: `/providers/${t.credential_id}` } : {})}
                          />
                        </TableCell>
                        <TableCell className="flex items-center gap-2 font-medium">
                          {t.model}
                          {!t.known_model ? (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-amber-600"
                              title="Not in the model catalog — capabilities can't be verified"
                            >
                              <AlertTriangle className="h-3.5 w-3.5" /> unverified
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">{t.priority}</TableCell>
                        <TableCell className="text-right">{t.weight}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ))}
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet — add one below to make this route resolvable.
          </p>
        ) : null}
      </div>

      <FeatureCard>
        <CardHeader>
          <CardTitle>Update route</CardTitle>
          <CardDescription>
            Versions are immutable, so an edit publishes a new one — prefilled with what is live
            now. Activate it when you are ready; the current version keeps serving until you do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add a provider credential first — a version needs at least one target.
            </p>
          ) : (
            <AddVersionForm
              action={addVersionAction}
              routeId={route.id}
              credentials={credentials}
              // Seeded from what is serving traffic, so changing one target does not mean retyping
              // the rest — and so adding a fallback is one row, not a full re-entry.
              initialRows={activeTargets}
              submitLabel="Save as new version"
            />
          )}
        </CardContent>
      </FeatureCard>
    </div>
  );
}
