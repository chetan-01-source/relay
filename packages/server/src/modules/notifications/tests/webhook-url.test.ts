import { describe, it, expect } from 'vitest';
import { checkWebhookUrl, maskWebhookUrl, teamsPayloadFormat } from '../lib/webhook-url.js';

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
const TEAMS_LEGACY = 'https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/xyz/123';
const TEAMS_WORKFLOW =
  'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke';

describe('checkWebhookUrl — accepts the real thing', () => {
  it('accepts a Slack incoming webhook', () => {
    expect(checkWebhookUrl('slack_webhook', SLACK)).toBeNull();
  });

  it('accepts both generations of Teams webhook', () => {
    expect(checkWebhookUrl('msteams_webhook', TEAMS_LEGACY)).toBeNull();
    expect(checkWebhookUrl('msteams_webhook', TEAMS_WORKFLOW)).toBeNull();
  });
});

// This is the SSRF boundary. The gateway fetches these URLs from inside the network, so a tenant
// who can name an internal address can make Relay reach it on their behalf.
describe('checkWebhookUrl — refuses to become an SSRF primitive', () => {
  it('rejects the cloud metadata endpoint', () => {
    // The single most valuable target: it hands out instance credentials to whoever asks.
    expect(checkWebhookUrl('msteams_webhook', 'https://169.254.169.254/latest/meta-data/')).toEqual(
      {
        message: 'That address is on a private or reserved network.',
      },
    );
  });

  it('rejects loopback and private ranges, v4 and v6', () => {
    for (const host of [
      'https://127.0.0.1/hook',
      'https://10.1.2.3/hook',
      'https://192.168.0.5/hook',
      'https://172.16.9.9/hook',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
      'https://[::ffff:10.0.0.1]/hook',
    ]) {
      expect(checkWebhookUrl('msteams_webhook', host)?.message).toBe(
        'That address is on a private or reserved network.',
      );
    }
  });

  it('rejects plaintext http — the URL is itself the credential', () => {
    expect(checkWebhookUrl('slack_webhook', SLACK.replace('https:', 'http:'))?.message).toMatch(
      /must use https/,
    );
  });

  it('rejects embedded credentials and odd ports', () => {
    expect(
      checkWebhookUrl('slack_webhook', 'https://u:p@hooks.slack.com/services/x')?.message,
    ).toMatch(/must not contain credentials/);
    expect(
      checkWebhookUrl('slack_webhook', 'https://hooks.slack.com:8443/services/x')?.message,
    ).toMatch(/default https port/);
  });

  it('rejects a host that is not the vendor’s', () => {
    // A look-alike host is the obvious way to exfiltrate the alerts themselves.
    expect(
      checkWebhookUrl('slack_webhook', 'https://hooks.slack.com.evil.test/x')?.message,
    ).toMatch(/hooks\.slack\.com/);
    expect(checkWebhookUrl('msteams_webhook', 'https://example.test/hook')?.message).toMatch(
      /not a Microsoft Teams webhook/,
    );
  });

  it('rejects a value that is not a URL at all', () => {
    expect(checkWebhookUrl('slack_webhook', 'paste your webhook here')?.message).toBe(
      'Enter a valid URL.',
    );
  });
});

describe('maskWebhookUrl', () => {
  it('identifies the webhook without disclosing it', () => {
    const masked = maskWebhookUrl(SLACK);
    expect(masked).toBe('hooks.slack.com/…mnop');
    // The unguessable part is the path, and it must not survive.
    expect(masked).not.toContain('T000');
    expect(masked).not.toContain('abcdefghij');
  });
});

describe('teamsPayloadFormat', () => {
  it('picks the shape the endpoint actually accepts', () => {
    // Sending the wrong generation's payload posts a blank card rather than failing loudly.
    expect(teamsPayloadFormat(TEAMS_LEGACY)).toBe('message_card');
    expect(teamsPayloadFormat(TEAMS_WORKFLOW)).toBe('adaptive_card');
  });
});
