'use client';

import { useActionState, useState } from 'react';
import { PROVIDERS, providerInfo } from 'relay-shared';
import { createProviderAction, type ActionResult } from '../app/(console)/providers/actions';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: ActionResult = { ok: false };

/**
 * Write-only provider credential form. The secret is sent once and never rendered back — the field
 * is a password input and the value lives only in this form submission.
 *
 * The provider list comes from the shared registry, not from options typed in here, so a provider
 * added to the gateway cannot be one the console silently fails to offer. The registry also carries
 * each provider's default base URL, which is what lets this form ask for one only when there is
 * genuinely no answer — a self-hosted server or an Azure resource at the customer's own hostname.
 */
export function CreateProviderForm() {
  const [state, action, pending] = useActionState(createProviderAction, INITIAL);
  const [providerId, setProviderId] = useState<string>('openai');

  const selected = providerInfo(providerId);
  // No published address ⇒ the operator must supply one, and the gateway rejects the create without
  // it. Asking here turns a 400 from the API into a required field.
  const baseUrlRequired = selected?.defaultBaseUrl === null;

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
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          className="flex h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        {selected ? <p className="text-xs text-muted-foreground">{selected.hint}</p> : null}
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="p-base-url">
          Base URL{' '}
          {baseUrlRequired ? '' : <span className="text-muted-foreground">(optional)</span>}
        </Label>
        <Input
          id="p-base-url"
          name="baseUrl"
          type="url"
          // Re-keyed per provider so switching providers replaces the placeholder rather than
          // leaving the previous vendor's URL sitting in the field looking like a real value.
          key={providerId}
          defaultValue=""
          placeholder={selected?.defaultBaseUrl ?? 'https://your-host.example.com'}
          required={baseUrlRequired}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {baseUrlRequired
            ? 'Required — this provider has no fixed address.'
            : `Leave blank to use ${selected?.defaultBaseUrl ?? 'the default'}. Set it to route through a proxy or a regional endpoint.`}
        </p>
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
