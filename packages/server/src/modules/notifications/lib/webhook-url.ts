/**
 * Validation for tenant-supplied webhook URLs — PURE, so every rule is unit-tested without a socket.
 *
 * This is a security boundary, not a formatting check. A tenant types a URL into the console and the
 * GATEWAY is what fetches it, from inside your network. Without a guard that turns the notifications
 * feature into a server-side request forgery primitive: point a "Slack webhook" at
 * `http://169.254.169.254/latest/meta-data/` and Relay will happily POST to the cloud metadata
 * service on the tenant's behalf, or at `http://localhost:9090/` and reach the health/metrics port
 * that is deliberately not exposed.
 *
 * So the rules are deny-by-default:
 *   • https only — a webhook secret must not cross the wire in clear text.
 *   • no credentials in the URL, no non-standard port.
 *   • literal private, loopback, link-local and unique-local addresses are rejected outright.
 *   • Slack must be its documented webhook host; there is no legitimate second one.
 *
 * What this canNOT do is resolve DNS — a hostname that points at 10.0.0.5 passes here. That check
 * belongs at connect time and is noted as a limitation rather than pretended away. The literal-IP
 * rules still close the easy path, which is what an attacker reaches for first.
 */

export type WebhookChannelType = 'slack_webhook' | 'msteams_webhook';

/** Slack posts every incoming webhook through exactly this host. */
const SLACK_HOST = 'hooks.slack.com';

/**
 * Hosts Microsoft serves Teams webhooks from. Two generations are live: the retiring Office 365
 * connectors (`*.webhook.office.com`) and Power Automate Workflows (`*.logic.azure.com` and the
 * Power Platform domains). Suffix-matched, because the subdomain is per-tenant.
 */
const TEAMS_HOST_SUFFIXES = [
  '.webhook.office.com',
  'outlook.office.com',
  'outlook.office365.com',
  '.logic.azure.com',
  '.powerplatform.com',
  '.powerautomate.com',
];

/** Reserved IPv4 ranges no outbound webhook has any business reaching. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true; // private, loopback, "this network"
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local — the cloud metadata endpoint lives here
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** IPv6 loopback, link-local and unique-local, including IPv4-mapped forms. */
function isPrivateIpv6(host: string): boolean {
  const raw = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (raw === '::1' || raw === '::') return true;
  if (raw.startsWith('fe80:') || raw.startsWith('fc') || raw.startsWith('fd')) return true;
  // IPv4-mapped addresses (::ffff:10.0.0.1) are IPv4 wearing an IPv6 hat, and must be judged as
  // IPv4. Both spellings have to be handled: WHATWG URL parsing rewrites the dotted form into hex
  // groups (`::ffff:a00:1`), so matching only the readable one would let every mapped private
  // address through — which is precisely the bypass this function exists to stop.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (dotted) return isPrivateIpv4(dotted[1]!);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(raw);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return false;
}

export interface WebhookUrlProblem {
  /** Human-readable reason, safe to show the person who typed the URL. */
  message: string;
}

/**
 * Check a webhook URL for `type`. Returns null when it is acceptable, or the reason it is not.
 *
 * Returning the problem rather than throwing keeps this usable both at the API boundary (where it
 * becomes a 400 naming the field) and in tests, without either one depending on the error catalogue.
 */
export function checkWebhookUrl(type: WebhookChannelType, raw: string): WebhookUrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { message: 'Enter a valid URL.' };
  }

  if (url.protocol !== 'https:') {
    return { message: 'The webhook URL must use https — the URL itself is a secret.' };
  }
  if (url.username || url.password) {
    return { message: 'The webhook URL must not contain credentials.' };
  }
  if (url.port && url.port !== '443') {
    return { message: 'The webhook URL must use the default https port.' };
  }

  const host = url.hostname.toLowerCase();
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { message: 'That address is on a private or reserved network.' };
  }

  if (type === 'slack_webhook' && host !== SLACK_HOST) {
    return { message: `A Slack webhook URL is served from ${SLACK_HOST}.` };
  }
  if (type === 'msteams_webhook' && !TEAMS_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return {
      message:
        'That is not a Microsoft Teams webhook URL. Use the address from a Teams Workflow or an Incoming Webhook connector.',
    };
  }

  return null;
}

/**
 * A non-secret hint for the console: enough to recognise WHICH webhook is configured, not enough to
 * post to it. The path is where Slack and Teams keep the unguessable part, so it is dropped entirely
 * and only the host plus a short tail survives.
 */
export function maskWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const tail = url.pathname.replace(/\/+$/, '').slice(-4);
    return `${url.hostname}/…${tail}`;
  } catch {
    return 'configured';
  }
}

/**
 * Which payload shape a Teams endpoint expects.
 *
 * The two generations are not compatible: a retiring Office 365 connector wants a MessageCard, and a
 * Power Automate Workflow wants an Adaptive Card in an `attachments` array. Sending the wrong one
 * posts an empty card. The host tells them apart, so the tenant never has to know which they have.
 */
export function teamsPayloadFormat(raw: string): 'message_card' | 'adaptive_card' {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.endsWith('.webhook.office.com') ||
      host === 'outlook.office.com' ||
      host === 'outlook.office365.com'
      ? 'message_card'
      : 'adaptive_card';
  } catch {
    return 'adaptive_card';
  }
}
