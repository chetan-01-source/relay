/**
 * Platform-admin org detail (Day 13 · FE-1). One tenant's lifecycle controls — entitlement matrix,
 * onboarding state-machine advance, and suspend/unsuspend — all consuming existing tenancy endpoints
 * (no new backend). Gated server-side by requireAdmin; the gateway remains the real authority.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireAdmin } from '../../../lib/auth';
import { getOrg, getEntitlements, listMembers } from '../../../lib/api';
import { FEATURE_KEYS } from '../../../lib/features';
import {
  updateEntitlementsAction,
  suspendOrgAction,
  unsuspendOrgAction,
  advanceOnboardingAction,
} from '../actions';
import { inviteMemberAction, removeMemberAction } from '../members-actions';
import { FeatureCard } from '../../../../components/ui/feature-card';
import { Card, CardHeader, CardTitle, CardContent } from '../../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../../components/ui/table';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

// The onboarding state machine, in order — used to render progress and the next-step label.
const ONBOARDING_STEPS = ['created', 'admin_invited', 'provider_added', 'first_request'] as const;

export default async function OrgDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  await requireAdmin();
  const { orgId } = await params;

  const org = await getOrg(orgId).catch(() => null);
  if (!org?.id) notFound();

  const entitlements = await getEntitlements(orgId).catch(() => null);
  const flags = entitlements?.features ?? {};
  // Members come from Logto → null when Logto M2M isn't configured (503) or the call fails.
  const members = await listMembers(orgId)
    .then((r) => r.data ?? [])
    .catch(() => null);
  const state = org.onboarding_state ?? 'created';
  const stepIndex = ONBOARDING_STEPS.indexOf(state);
  const isComplete = stepIndex >= ONBOARDING_STEPS.length - 1;
  const suspended = org.status === 'suspended';

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/orgs"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="mr-1 h-4 w-4" /> Organizations
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          <Badge variant={suspended ? 'secondary' : 'success'}>{org.status}</Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{org.id}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <FeatureCard>
          <CardHeader>
            <CardTitle>Onboarding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="space-y-1.5 text-sm">
              {ONBOARDING_STEPS.map((step, i) => (
                <li key={step} className="flex items-center gap-2">
                  <span
                    className={`flex size-5 items-center justify-center rounded-full text-[11px] font-medium ${
                      i <= stepIndex
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className={i <= stepIndex ? 'font-medium' : 'text-muted-foreground'}>
                    {step}
                  </span>
                </li>
              ))}
            </ol>
            {isComplete ? (
              <p className="text-sm text-muted-foreground">Onboarding complete.</p>
            ) : (
              <form action={advanceOnboardingAction}>
                <input type="hidden" name="orgId" value={org.id} />
                <Button type="submit" size="sm">
                  Advance onboarding
                </Button>
              </form>
            )}
          </CardContent>
        </FeatureCard>

        <FeatureCard>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {suspended
                ? 'This org is suspended — the data plane rejects its virtual keys.'
                : 'Suspending rejects all of this org’s virtual keys within ~1s.'}
            </p>
            {suspended ? (
              <form action={unsuspendOrgAction}>
                <input type="hidden" name="orgId" value={org.id} />
                <Button type="submit" size="sm">
                  Reactivate
                </Button>
              </form>
            ) : (
              <form action={suspendOrgAction}>
                <input type="hidden" name="orgId" value={org.id} />
                <Button type="submit" variant="destructive" size="sm">
                  Suspend
                </Button>
              </form>
            )}
          </CardContent>
        </FeatureCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {members === null ? (
            <p className="text-sm text-muted-foreground">
              Member management is unavailable — Logto is not configured for this deployment.
            </p>
          ) : (
            <>
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground">No members yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{m.email ?? '—'}</TableCell>
                        <TableCell className="text-right">
                          <form action={removeMemberAction}>
                            <input type="hidden" name="orgId" value={org.id} />
                            <input type="hidden" name="userId" value={m.id} />
                            <Button type="submit" variant="ghost" size="sm">
                              Remove
                            </Button>
                          </form>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <form action={inviteMemberAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="orgId" value={org.id} />
                <div className="space-y-1.5">
                  <Label htmlFor="email">Invite by email</Label>
                  <Input id="email" name="email" type="email" required placeholder="dev@acme.com" />
                </div>
                <Button type="submit" variant="outline" size="sm">
                  Send invite
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entitlements</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={updateEntitlementsAction} className="flex flex-wrap items-center gap-4">
            <input type="hidden" name="orgId" value={org.id} />
            {FEATURE_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  name={`feature:${key}`}
                  defaultChecked={flags[key] === true}
                  className="size-4 accent-primary"
                />
                {key}
              </label>
            ))}
            <Button type="submit" variant="outline" size="sm">
              Save entitlements
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
