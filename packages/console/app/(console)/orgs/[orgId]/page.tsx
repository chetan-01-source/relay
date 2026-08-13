/**
 * Platform-admin org detail (Day 13 · FE-1). One tenant's lifecycle controls — entitlement matrix,
 * onboarding state-machine advance, and suspend/unsuspend — all consuming existing tenancy endpoints
 * (no new backend). Gated server-side by requireAdmin; the gateway remains the real authority.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireAdmin } from '../../../lib/auth';
import { getOrg, getEntitlements, listMembers, listInvitations } from '../../../lib/api';
import { FEATURE_KEYS } from '../../../lib/features';
import { ONBOARDING_STEPS, nextOnboardingState } from '../../../lib/onboarding';
import {
  updateEntitlementsAction,
  suspendOrgAction,
  unsuspendOrgAction,
  advanceOnboardingAction,
} from '../actions';
import {
  InviteMemberForm,
  MemberRoleForm,
  RemoveMemberForm,
  ResendInvitationForm,
  RevokeInvitationForm,
} from '../../../../components/member-forms';
import { LocalTime } from '../../../../components/local-time';
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
import { Badge } from '../../../../components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function OrgDetailPage({ params }: { params: Promise<{ orgId: string }> }) {
  await requireAdmin();
  const { orgId } = await params;

  const org = await getOrg(orgId).catch(() => null);
  if (!org?.id) notFound();

  const entitlements = await getEntitlements(orgId).catch(() => null);
  const flags = entitlements?.features ?? {};
  // Members and invitations both come from Logto → null when Logto M2M isn't configured (503) or the
  // call fails. Only invitations still awaiting a decision are worth a row; the rest are history.
  const members = await listMembers(orgId)
    .then((r) => r.data ?? [])
    .catch(() => null);
  const pending = await listInvitations(orgId)
    .then((r) => (r.data ?? []).filter((i) => i.status === 'pending'))
    .catch(() => []);
  const state = org.onboarding_state ?? 'created';
  const stepIndex = (ONBOARDING_STEPS as readonly string[]).indexOf(state);
  const nextState = nextOnboardingState(state);
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
            {nextState === null ? (
              <p className="text-sm text-muted-foreground">Onboarding complete.</p>
            ) : (
              <form action={advanceOnboardingAction}>
                <input type="hidden" name="orgId" value={org.id} />
                <input type="hidden" name="state" value={nextState} />
                <Button type="submit" size="sm">
                  Advance to {nextState}
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
                      <TableHead>Role</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.name ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{m.email ?? '—'}</TableCell>
                        <TableCell>
                          {m.id ? (
                            <MemberRoleForm
                              orgId={orgId}
                              userId={m.id}
                              role={m.role === 'admin' ? 'admin' : 'member'}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {m.id ? (
                            <RemoveMemberForm orgId={orgId} userId={m.id} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {pending.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Pending invitations</h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pending.map((invitation) => (
                        <TableRow key={invitation.id}>
                          <TableCell className="font-medium">{invitation.email}</TableCell>
                          <TableCell>
                            <Badge variant={invitation.role === 'admin' ? 'outline' : 'secondary'}>
                              {invitation.role ?? 'member'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            <LocalTime iso={invitation.expires_at} />
                          </TableCell>
                          <TableCell className="text-right">
                            <ResendInvitationForm orgId={orgId} invitationId={invitation.id!} />
                            <RevokeInvitationForm orgId={orgId} invitationId={invitation.id!} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}

              <InviteMemberForm orgId={orgId} />
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
