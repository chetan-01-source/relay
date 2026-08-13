'use client';

/**
 * The accept button on the invitation page. A client component so a refusal — a revoked link, an
 * expired one — renders inline instead of escaping as an unhandled throw and blanking the page.
 */
import { useActionState } from 'react';
import { acceptInvitationAction, type AcceptResult } from '../app/invitations/[id]/actions';
import { Button } from './ui/button';

const INITIAL: AcceptResult = { ok: false };

export function AcceptInvitationForm({
  invitationId,
  orgName,
}: {
  invitationId: string;
  orgName: string;
}) {
  const [state, action, pending] = useActionState(acceptInvitationAction, INITIAL);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Joining…' : `Join ${orgName}`}
      </Button>
      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
