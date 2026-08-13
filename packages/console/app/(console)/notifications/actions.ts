'use server';

/**
 * Server actions for the notifications screen.
 *
 * Every secret here — the SMTP password, and the Slack/Teams webhook URL, which is itself authority
 * to post into a company chat room — travels browser → Next server → gateway, which seals it. The
 * console never stores one and never receives one back on a read, so a blank field always means
 * "keep what is stored" rather than "clear it".
 */
import { revalidatePath } from 'next/cache';
import {
  setNotificationChannel,
  deleteNotificationChannel,
  setNotificationPreference,
  testNotificationChannel,
  type ChannelType,
} from '../../lib/api';

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set by the test action — the provider's own words, success or failure. */
  detail?: string;
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

/** Anything not a known channel kind is refused before it reaches the gateway. */
function channelType(formData: FormData): ChannelType | null {
  const type = field(formData, 'type');
  return type === 'email_smtp' || type === 'slack_webhook' || type === 'msteams_webhook'
    ? type
    : null;
}

export async function setChannelAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const host = field(formData, 'host');
  const fromAddress = field(formData, 'from_address');
  const port = Number(field(formData, 'port'));
  if (!host) return { ok: false, error: 'SMTP host is required.' };
  if (!fromAddress.includes('@')) return { ok: false, error: 'From address must be an email.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be between 1 and 65535.' };
  }

  const password = field(formData, 'password');
  try {
    await setNotificationChannel('email_smtp', {
      host,
      port,
      from_address: fromAddress,
      secure: formData.get('secure') === 'on',
      enabled: formData.get('enabled') === 'on',
      ...(field(formData, 'user') ? { user: field(formData, 'user') } : {}),
      // Blank means "keep the stored secret" — re-saving the host must not wipe the password.
      ...(password ? { password } : {}),
    });
    revalidatePath('/notifications');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

/**
 * Save a Slack or Teams webhook.
 *
 * The URL is validated by the gateway, not here: it enforces https, the vendor's own host, and a
 * refusal to point at a private address. Duplicating those rules in the browser would mean two
 * places to keep correct and would still not be the boundary.
 */
export async function setWebhookChannelAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const type = channelType(formData);
  if (!type || type === 'email_smtp') return { ok: false, error: 'Unknown channel.' };

  const webhookUrl = field(formData, 'webhook_url');
  try {
    await setNotificationChannel(type, {
      enabled: formData.get('enabled') === 'on',
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    });
    revalidatePath('/notifications');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

export async function deleteChannelAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const type = channelType(formData);
  if (!type) return { ok: false, error: 'Unknown channel.' };
  try {
    await deleteNotificationChannel(type);
    revalidatePath('/notifications');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

/**
 * Send a test message. A rejected webhook is a RESULT, not an error — "Slack says invalid_token" is
 * the answer the operator asked for, so it comes back as `detail` rather than an exception.
 */
export async function testChannelAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const type = channelType(formData);
  if (!type) return { ok: false, error: 'Unknown channel.' };
  try {
    const result = await testNotificationChannel(type);
    return result.ok
      ? { ok: true, detail: result.detail ?? 'Sent.' }
      : { ok: false, error: result.detail ?? 'The channel rejected the message.' };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

export async function setPreferenceAction(formData: FormData): Promise<void> {
  const event = field(formData, 'event');
  if (!event) return;
  const recipients = field(formData, 'recipients')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  await setNotificationPreference(event, formData.get('enabled') === 'on', recipients);
  revalidatePath('/notifications');
}
