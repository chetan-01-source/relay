'use client';

/**
 * SMTP channel form. Configuring this is an OVERRIDE — an org with no channel still gets mail from
 * the platform's transport. The form says so, because "not configured" looking like "broken" would
 * push people into setting up SMTP they do not need.
 *
 * The password field is write-only: it renders empty even when a secret is stored, and an empty
 * submit keeps the stored one. That mirrors the provider-credential form and the gateway's
 * behaviour, so re-saving a host cannot silently wipe the password.
 */
import { useActionState } from 'react';
import { Trash2 } from 'lucide-react';
import { setChannelAction, type ActionResult } from '../app/(console)/notifications/actions';
import type { NotificationChannel } from '../app/lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: ActionResult = { ok: false };

export function ChannelForm({ channel }: { channel: NotificationChannel | null }) {
  const [state, action, pending] = useActionState(setChannelAction, INITIAL);

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="from_address">From address</Label>
          <Input
            id="from_address"
            name="from_address"
            type="email"
            defaultValue={channel?.from_address ?? ''}
            placeholder="relay@yourdomain.com"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="host">SMTP host</Label>
          <Input
            id="host"
            name="host"
            defaultValue={channel?.host ?? ''}
            placeholder="smtp.yourprovider.com"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="port">Port</Label>
          <Input
            id="port"
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={channel?.port ?? 587}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user">Username (optional)</Label>
          <Input id="user" name="user" defaultValue={channel?.user ?? ''} autoComplete="off" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={channel?.has_secret ? 'Stored — leave blank to keep it' : 'SMTP password'}
          />
          <p className="text-xs text-muted-foreground">
            Sealed on save and never shown again
            {channel?.has_secret ? ' — one is currently stored' : ''}.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="secure"
            defaultChecked={channel?.secure ?? false}
            className="size-4 accent-primary"
          />
          Implicit TLS (usually port 465)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={channel?.enabled ?? true}
            className="size-4 accent-primary"
          />
          Use this channel
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : channel ? 'Update channel' : 'Save channel'}
        </Button>
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>

      {channel ? (
        <p className="text-xs text-muted-foreground">
          <Trash2 className="mr-1 inline h-3 w-3" aria-hidden="true" />
          Removing this channel falls back to the platform default — it does not stop notifications.
        </p>
      ) : null}
    </form>
  );
}
