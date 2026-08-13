/**
 * The page an organization invitation links to — the ONLY place a join happens.
 *
 * It lives outside the (console) group on purpose. That layout requires a resolvable gateway
 * identity and every page under it re-gates on an org, which is precisely what an invitee does not
 * have yet: the point of this page is to give them one. Signing up for a Relay account and joining
 * an organization are separate acts, and this is where the second one occurs.
 *
 * Authorization is the gateway's, not this page's: it returns the invitation only to the address it
 * was sent to. A forwarded link renders "sent to a different address" and nothing about the tenant.
 */
import Link from 'next/link';
import { getLogtoContext } from '@logto/next/server-actions';
import { getInvitation } from '../../lib/api';
import { logtoConfig, logtoConfigured } from '../../lib/logto';
import { signInWithReturnAction, signOutAction } from '../../actions';
import { AcceptInvitationForm } from '../../../components/accept-invitation-form';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '../../../components/ui/card';
import { ThemeToggle } from '../../../components/theme-toggle';

// Reads cookies and the invitation's live status — never statically prerender.
export const dynamic = 'force-dynamic';

export default async function InvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-6">
      <div className="fixed right-4 top-4">
        <ThemeToggle />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">You’ve been invited</CardTitle>
          <CardDescription>Join an organization on Relay.</CardDescription>
        </CardHeader>
        <CardContent>{await body(id)}</CardContent>
      </Card>
    </main>
  );
}

async function body(id: string) {
  if (!logtoConfigured) {
    return (
      <p className="text-sm text-muted-foreground">
        Logto is not configured for this deployment, so invitations cannot be accepted.
      </p>
    );
  }

  const { isAuthenticated, claims } = await getLogtoContext(logtoConfig);
  if (!isAuthenticated) {
    // Sign-in doubles as sign-up: a first-time invitee registers in Logto and lands back here.
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Sign in — or create your Relay account — to see who invited you. Use the address the
          invitation was sent to.
        </p>
        <form action={signInWithReturnAction}>
          <input type="hidden" name="returnTo" value={`/invitations/${id}`} />
          <Button type="submit" className="w-full">
            Continue with Logto
          </Button>
        </form>
      </div>
    );
  }

  const signedInAs = claims?.email ?? claims?.sub;

  let invitation: Awaited<ReturnType<typeof getInvitation>>;
  try {
    invitation = await getInvitation(id);
  } catch {
    // A 403 (wrong account) is indistinguishable from a 404 here BY DESIGN — neither may reveal that
    // an org exists behind this link, so both produce the same message and the same way out.
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          This invitation isn’t available for the account you’re signed in as
          {signedInAs ? ` (${signedInAs})` : ''}. It may have been revoked, or it was sent to a
          different email address.
        </p>
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm" className="w-full">
            Sign in as someone else
          </Button>
        </form>
      </div>
    );
  }

  if (invitation.status !== 'pending') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {invitation.status === 'accepted'
            ? `You’ve already joined ${invitation.org_name}.`
            : `This invitation to ${invitation.org_name} has ${invitation.status === 'expired' ? 'expired' : 'been revoked'}. Ask an administrator to send a new one.`}
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link href="/">Back to Relay</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{invitation.org_name}</span> invited{' '}
        {invitation.email} to join. Accepting adds your account to that organization.
      </p>
      <AcceptInvitationForm
        invitationId={invitation.id ?? id}
        orgName={invitation.org_name ?? 'the organization'}
      />
      <p className="text-xs text-muted-foreground">
        Signed in as {signedInAs}. You’ll be returned to Logto briefly so your session picks up the
        new membership.
      </p>
    </div>
  );
}
