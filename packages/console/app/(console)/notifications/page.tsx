/**
 * Notifications — who gets told what, how it is delivered, and what actually happened.
 *
 * Three sections in the order an operator needs them: preferences (the thing they came to change),
 * the delivery channels (an override, not a prerequisite), and the delivery log (the evidence that
 * something did or did not go out, including *why* it did not).
 *
 * Channels are additive, not exclusive: an org can have email AND Slack AND Teams, and one event
 * reaches all of them. That is why each is its own card rather than a picker.
 */
import Link from 'next/link';
import { Bell, Send, ScrollText, MessageSquare } from 'lucide-react';
import { requireOrg, isOrgAdmin } from '../../lib/auth';
import {
  listNotificationChannels,
  listNotificationPreferences,
  listNotifications,
  type ChannelType,
  type NotificationChannel,
} from '../../lib/api';
import { setPreferenceAction } from './actions';
import { ChannelForm } from '../../../components/channel-form';
import { WebhookChannelForm } from '../../../components/webhook-channel-form';
import { LocalTime } from '../../../components/local-time';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../components/ui/table';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';

export const dynamic = 'force-dynamic';

/** Delivery outcomes, coloured by what they mean for the operator. */
function statusVariant(status: string): 'success' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'sent') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'suppressed') return 'outline';
  return 'secondary'; // pending / sending
}

/** Read-only view of a channel for members, who may see the state but not the credential. */
function ChannelState({ channel }: { channel: NotificationChannel | null }) {
  if (!channel?.has_secret) {
    return <p className="text-sm text-muted-foreground">Not configured.</p>;
  }
  return (
    <p className="text-sm text-muted-foreground">
      A webhook is configured and {channel.enabled ? 'enabled' : 'disabled'}.
    </p>
  );
}

export default async function NotificationsPage() {
  const me = await requireOrg();
  // Channels hold credentials, so the gateway restricts writing them to org administrators. Members
  // still see what is configured — hiding the state would make a silent channel impossible to debug.
  const canManage = isOrgAdmin(me);

  const [channels, preferences, log] = await Promise.all([
    listNotificationChannels()
      .then((r) => r.data ?? [])
      .catch(() => [] as NotificationChannel[]),
    listNotificationPreferences()
      .then((r) => r.data ?? [])
      .catch(() => []),
    listNotifications(50)
      .then((r) => r.data ?? [])
      .catch(() => []),
  ]);
  const byType = new Map(channels.map((c) => [c.type as ChannelType, c]));
  const channel = byType.get('email_smtp') ?? null;
  const slack = byType.get('slack_webhook') ?? null;
  const teams = byType.get('msteams_webhook') ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Alerts for spend, access and configuration changes, delivered by email, Slack and Teams.
          Every attempt is recorded below.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Events
          </CardTitle>
          <CardDescription>
            Organization members receive these by default. Add extra addresses (comma separated) for
            an on-call alias or a finance inbox.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {preferences.map((preference) => (
            <form
              key={preference.event_type}
              action={setPreferenceAction}
              className="flex flex-wrap items-end justify-between gap-3 rounded-md border p-3"
            >
              <input type="hidden" name="event" value={preference.event_type} />
              <div className="min-w-0 flex-1">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={preference.enabled}
                    className="size-4 accent-primary"
                  />
                  {preference.label}
                </label>
                <p className="mt-1 text-xs text-muted-foreground">{preference.description}</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {preference.event_type}
                </p>
              </div>
              <div className="flex items-end gap-2">
                <Input
                  name="recipients"
                  defaultValue={(preference.recipients ?? []).join(', ')}
                  placeholder="extra@example.com"
                  className="w-56"
                  aria-label={`Extra recipients for ${preference.label}`}
                />
                <Button type="submit" variant="outline" size="sm">
                  Save
                </Button>
              </div>
            </form>
          ))}
        </CardContent>
      </Card>

      {canManage ? null : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Delivery channels hold credentials, so only an organization administrator can change
            them. What is configured is shown below.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Email
          </CardTitle>
          <CardDescription>
            {channel
              ? 'Mail is sent through your own SMTP server.'
              : 'Using the platform’s mail server. Configure SMTP below to send from your own domain — this is optional.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <ChannelForm channel={channel} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {channel?.host
                ? `Sending through ${channel.host} as ${channel.from_address}.`
                : 'Using the platform mail server.'}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Slack
            </CardTitle>
            <CardDescription>
              {slack?.enabled
                ? 'Alerts are posted to your Slack channel.'
                : 'Post alerts into a Slack channel with an incoming webhook.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <WebhookChannelForm
                type="slack_webhook"
                channel={slack}
                placeholder="https://hooks.slack.com/services/…"
                hint="Slack → your app → Incoming Webhooks → Add New Webhook to Workspace. The URL selects the channel."
              />
            ) : (
              <ChannelState channel={slack} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Microsoft Teams
            </CardTitle>
            <CardDescription>
              {teams?.enabled
                ? 'Alerts are posted to your Teams channel.'
                : 'Post alerts into a Teams channel with a Workflow or an Incoming Webhook.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <WebhookChannelForm
                type="msteams_webhook"
                channel={teams}
                placeholder="https://…logic.azure.com/workflows/…"
                hint="Teams → channel → Workflows → “Post to a channel when a webhook request is received”. Older Incoming Webhook connector URLs also work."
              />
            ) : (
              <ChannelState channel={teams} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Delivery log
          </CardTitle>
          <CardDescription>
            The 50 most recent notifications. <strong>Suppressed</strong> means nothing was sent,
            and the reason says why.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Notifications appear here as events occur — try changing a{' '}
              <Link href="/budgets" className="underline">
                budget
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      <LocalTime iso={entry.created_at} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.event_type}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(entry.status ?? '')}>{entry.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{entry.attempts}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(entry.recipients ?? []).length > 0
                        ? (entry.recipients ?? []).join(', ')
                        : '—'}
                    </TableCell>
                    <TableCell
                      className="max-w-xs truncate text-xs text-muted-foreground"
                      title={entry.last_error ?? undefined}
                    >
                      {entry.last_error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
