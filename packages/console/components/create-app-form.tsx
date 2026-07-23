'use client';

import { useActionState } from 'react';
import { createAppAction, type ActionResult } from '../app/(console)/apps/actions';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: ActionResult = { ok: false };

/** Inline create-application form. On success the server action revalidates the list, so the new app
 * appears without a client refetch. */
export function CreateAppForm() {
  const [state, action, pending] = useActionState(createAppAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" placeholder="my-app" required maxLength={200} />
      </div>
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Input id="description" name="description" placeholder="optional" maxLength={1000} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create application'}
      </Button>
      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
