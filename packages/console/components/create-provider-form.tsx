'use client';

import { useActionState } from 'react';
import { createProviderAction, type ActionResult } from '../app/(console)/providers/actions';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: ActionResult = { ok: false };

/** Write-only provider credential form. The secret is sent once and never rendered back — the field
 * is a password input and the value lives only in this form submission. */
export function CreateProviderForm() {
  const [state, action, pending] = useActionState(createProviderAction, INITIAL);

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="p-name">Name</Label>
        <Input id="p-name" name="name" placeholder="prod-openai" required maxLength={200} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="p-provider">Provider</Label>
        <select
          id="p-provider"
          name="provider"
          defaultValue="openai"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="openai_compat">openai_compat</option>
        </select>
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="p-key">Secret key</Label>
        <Input
          id="p-key"
          name="apiKey"
          type="password"
          placeholder="sk-…"
          autoComplete="off"
          required
        />
        <p className="text-xs text-muted-foreground">
          Sealed on save. It is never displayed again — only the last 4 characters are shown.
        </p>
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save credential'}
        </Button>
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
