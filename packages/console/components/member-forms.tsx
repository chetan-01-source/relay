'use client';

/**
 * Invite and remove controls for the org members panel.
 *
 * Client components purely so the action's result can be rendered. These forms used to call the
 * server action directly, which meant any rejection — including "that address already has a pending
 * invitation" — escaped as an unhandled throw and Next replaced the page with its error overlay.
 * A duplicate invite is an ordinary thing to do; it should say so next to the field.
 */
import { useActionState } from 'react';
import {
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  setMemberRoleAction,
  type MemberActionResult,
} from '../app/(console)/orgs/members-actions';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: MemberActionResult = { ok: false };

export function InviteMemberForm({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState(inviteMemberAction, INITIAL);

  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgId" value={orgId} />
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Invite by email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="dev@acme.com"
            className="w-64"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            name="role"
            defaultValue="member"
            className="flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="member">Member (read-only)</option>
            <option value="admin">Admin (budgets + providers)</option>
          </select>
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Sending…' : 'Send invite'}
        </Button>
      </div>

      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className="text-sm text-emerald-600" role="status">
          Invitation emailed. It stays pending until they accept it.
        </p>
      ) : null}
    </form>
  );
}

/**
 * Flip a member between admin and member. Submitting on change keeps it to one interaction — there
 * is no second "save" step to forget, and the row re-renders with what the server actually stored.
 */
export function MemberRoleForm({
  orgId,
  userId,
  role,
}: {
  orgId: string;
  userId: string;
  role: 'admin' | 'member';
}) {
  const [state, action, pending] = useActionState(setMemberRoleAction, INITIAL);

  return (
    <form action={action} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="userId" value={userId} />
      <select
        name="role"
        defaultValue={role}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        aria-label="Member role"
        className="flex h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      {state.error ? (
        <span className="text-xs text-destructive" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

/** Re-send the invitation mail for one pending invitation. */
export function ResendInvitationForm({
  orgId,
  invitationId,
}: {
  orgId: string;
  invitationId: string;
}) {
  const [state, action, pending] = useActionState(resendInvitationAction, INITIAL);

  return (
    <form action={action} className="inline">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Sending…' : state.ok ? 'Sent' : 'Resend'}
      </Button>
      {state.error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Revoke a pending invitation — also the way to clear a duplicate before re-inviting. */
export function RevokeInvitationForm({
  orgId,
  invitationId,
}: {
  orgId: string;
  invitationId: string;
}) {
  const [state, action, pending] = useActionState(revokeInvitationAction, INITIAL);

  return (
    <form action={action} className="inline">
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Revoking…' : 'Revoke'}
      </Button>
      {state.error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function RemoveMemberForm({ orgId, userId }: { orgId: string; userId: string }) {
  const [state, action, pending] = useActionState(removeMemberAction, INITIAL);

  return (
    <form action={action}>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? 'Removing…' : 'Remove'}
      </Button>
      {state.error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
