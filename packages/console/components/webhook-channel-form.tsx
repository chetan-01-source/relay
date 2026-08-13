'use client';

/**
 * Slack / Microsoft Teams channel form.
 *
 * A chat channel is not a mailbox: there is no sender and no recipient list, because the webhook URL
 * IS the destination. So this form is one secret, one toggle, and a way to prove it works.
 *
 * The URL is write-only, exactly like the SMTP password and a provider key: it renders empty even
 * when one is stored, and an empty submit keeps the stored one. That is not a UI nicety — possession
 * of the URL is authority to post into the room, so the gateway never returns it and the form has
 * nothing to round-trip.
 *
 * "Send test" exists because every failure mode here is otherwise invisible until an incident: a
 * webhook revoked in Slack, a Teams flow someone deleted, a URL pasted with a trailing character.
 */
import { useActionState } from 'react';
import { CheckCircle2, Trash2 } from 'lucide-react';
import {
  setWebhookChannelAction,
  deleteChannelAction,
  testChannelAction,
  type ActionResult,
} from '../app/(console)/notifications/actions';
import type { ChannelType, NotificationChannel } from '../app/lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: ActionResult = { ok: false };

export interface WebhookChannelFormProps {
  type: Extract<ChannelType, 'slack_webhook' | 'msteams_webhook'>;
  channel: NotificationChannel | null;
  /** Where the operator gets the URL from — different in each product, and easy to get lost in. */
  hint: string;
  placeholder: string;
}

export function WebhookChannelForm({ type, channel, hint, placeholder }: WebhookChannelFormProps) {
  const [saveState, save, saving] = useActionState(setWebhookChannelAction, INITIAL);
  const [testState, test, testing] = useActionState(testChannelAction, INITIAL);
  const [removeState, remove, removing] = useActionState(deleteChannelAction, INITIAL);
  const configured = Boolean(channel?.has_secret);

  return (
    <div className="space-y-4">
      <form action={save} className="space-y-4">
        <input type="hidden" name="type" value={type} />

        <div className="space-y-1.5">
          <Label htmlFor={`${type}-url`}>Webhook URL</Label>
          <Input
            id={`${type}-url`}
            name="webhook_url"
            type="password"
            autoComplete="off"
            placeholder={configured ? 'Stored — leave blank to keep it' : placeholder}
            {...(configured ? {} : { required: true })}
          />
          <p className="text-xs text-muted-foreground">{hint}</p>
          <p className="text-xs text-muted-foreground">
            Sealed on save and never shown again{configured ? ' — one is currently stored' : ''}.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={channel?.enabled ?? true}
            className="size-4 accent-primary"
          />
          Send notifications here
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : configured ? 'Update' : 'Save'}
          </Button>
          {saveState.error ? (
            <p className="text-sm text-destructive" role="alert">
              {saveState.error}
            </p>
          ) : null}
          {saveState.ok ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600" role="status">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Saved.
            </p>
          ) : null}
        </div>
      </form>

      {configured ? (
        <div className="flex flex-wrap items-center gap-3 border-t pt-3">
          <form action={test}>
            <input type="hidden" name="type" value={type} />
            <Button type="submit" variant="outline" size="sm" disabled={testing}>
              {testing ? 'Sending…' : 'Send test'}
            </Button>
          </form>

          <form action={remove}>
            <input type="hidden" name="type" value={type} />
            <Button type="submit" variant="ghost" size="sm" disabled={removing}>
              <Trash2 aria-hidden="true" /> {removing ? 'Removing…' : 'Remove'}
            </Button>
          </form>

          {/* The provider's own words, verbatim — "invalid_token" tells the operator far more than
              "test failed" ever would. */}
          {testState.detail ? (
            <p className="text-sm text-emerald-600" role="status">
              {testState.detail}
            </p>
          ) : null}
          {testState.error ? (
            <p className="text-sm text-destructive" role="alert">
              {testState.error}
            </p>
          ) : null}
          {removeState.error ? (
            <p className="text-sm text-destructive" role="alert">
              {removeState.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
