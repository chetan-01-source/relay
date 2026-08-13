import { describe, it, expect, vi } from 'vitest';
import { backoffSeconds, isDead, MAX_ATTEMPTS } from '../lib/backoff.js';
import { createConsoleSender, createSmtpSender } from '../services/sender.js';
import { createBudgetAlertSink } from '../services/budget-alerts.js';
import type { NotificationEnqueuer } from '../types/notifications.types.js';

describe('retry schedule', () => {
  it('escalates so a broken channel is not retried in a tight loop', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(1500);
  });

  it('caps the wait so a stuck notification retries hourly rather than never', () => {
    expect(backoffSeconds(9)).toBe(3600);
    expect(backoffSeconds(99)).toBe(3600);
  });

  it('never returns a non-positive delay', () => {
    expect(backoffSeconds(0)).toBeGreaterThan(0);
    expect(backoffSeconds(-5)).toBeGreaterThan(0);
  });

  it('gives up after the attempt ceiling', () => {
    expect(isDead(MAX_ATTEMPTS - 1)).toBe(false);
    expect(isDead(MAX_ATTEMPTS)).toBe(true);
  });
});

describe('console sender (the default)', () => {
  it('reports success without delivering, so a dev stack never mails real members', async () => {
    const lines: string[] = [];
    const sender = createConsoleSender((line) => lines.push(line));
    await expect(
      sender.send({ to: ['a@example.com'], from: 'r@localhost', subject: 'S', text: 'B' }),
    ).resolves.toBeUndefined();
    expect(sender.kind).toBe('console');
    expect(lines[0]).toContain('not sent');
    expect(lines[0]).toContain('a@example.com');
  });
});

describe('smtp sender', () => {
  it('identifies its host, so the delivery log says where mail went', () => {
    const sender = createSmtpSender({ host: 'smtp.example.com', port: 587, secure: false });
    expect(sender.kind).toBe('smtp:smtp.example.com');
  });
});

describe('budget alert sink', () => {
  function makeSink() {
    const calls: { orgId: string; dedupeKey: string | null; event: string; payload: unknown }[] =
      [];
    const notify: NotificationEnqueuer = {
      enqueueWithTx: () => Promise.resolve(),
      enqueueDetached: (orgId, input) => {
        calls.push({
          orgId,
          dedupeKey: input.dedupeKey,
          event: input.event,
          payload: input.payload,
        });
        return Promise.resolve();
      },
    };
    return { sink: createBudgetAlertSink(notify), calls };
  }

  const base = {
    orgId: 'org-1',
    scope: 'app' as const,
    appId: 'app-1',
    period: 'monthly' as const,
    window: '2026-08',
    limitUsd: 0.0001,
    spentMicroUsd: 540,
  };

  // THE reason this adapter exists: a tripped ceiling rejects every request, so this fires
  // continuously. One key per (ceiling, period) collapses that to a single notification.
  it('produces one stable dedupe key however often the ceiling rejects', () => {
    const { sink, calls } = makeSink();
    sink.budgetExceeded(base);
    sink.budgetExceeded(base);
    sink.budgetExceeded(base);
    expect(new Set(calls.map((c) => c.dedupeKey)).size).toBe(1);
    expect(calls[0]?.dedupeKey).toBe('budget.exceeded:app-1:2026-08');
  });

  it('uses a different key next period, so the next month alerts again', () => {
    const { sink, calls } = makeSink();
    sink.budgetExceeded(base);
    sink.budgetExceeded({ ...base, window: '2026-09' });
    expect(calls[0]?.dedupeKey).not.toBe(calls[1]?.dedupeKey);
  });

  it('separates the org ceiling from an application ceiling', () => {
    const { sink, calls } = makeSink();
    sink.budgetExceeded(base);
    sink.budgetExceeded({ ...base, scope: 'org', appId: null });
    expect(calls[0]?.dedupeKey).not.toBe(calls[1]?.dedupeKey);
  });

  it('converts micro-USD to dollars for the template', () => {
    const { sink, calls } = makeSink();
    sink.budgetExceeded(base);
    expect(calls[0]?.payload).toMatchObject({ spentUsd: 0.00054, limitUsd: 0.0001 });
  });

  // It is called synchronously from the hot path and not awaited.
  it('never throws or rejects, even when enqueuing fails', () => {
    const notify: NotificationEnqueuer = {
      enqueueWithTx: () => Promise.resolve(),
      enqueueDetached: () => Promise.reject(new Error('postgres down')),
    };
    const failing = createBudgetAlertSink(notify);
    expect(() => failing.budgetExceeded(base)).not.toThrow();
  });

  it('warns once per ceiling per period, however many requests cross the mark', () => {
    const { sink, calls } = makeSink();
    const warn = { ...base, percent: 85 };
    sink.budgetThreshold(warn);
    sink.budgetThreshold(warn);
    expect(new Set(calls.map((c) => c.dedupeKey)).size).toBe(1);
    expect(calls[0]?.event).toBe('budget.threshold');
    expect(calls[0]?.dedupeKey).toBe('budget.threshold:app-1:2026-08');
  });

  it('keeps the threshold warning separate from the exceeded alert', () => {
    // Different events with different keys — crossing 80% must not suppress the later breach mail.
    const { sink, calls } = makeSink();
    sink.budgetThreshold({ ...base, percent: 85 });
    sink.budgetExceeded(base);
    expect(calls[0]?.dedupeKey).not.toBe(calls[1]?.dedupeKey);
    expect(calls.map((c) => c.event)).toEqual(['budget.threshold', 'budget.exceeded']);
  });

  it('carries the percentage so the email can state how close it is', () => {
    const { sink, calls } = makeSink();
    sink.budgetThreshold({ ...base, percent: 85 });
    expect(calls[0]?.payload).toMatchObject({ percent: 85, spentUsd: 0.00054 });
  });

  it('returns immediately rather than awaiting delivery', () => {
    const notify: NotificationEnqueuer = {
      enqueueWithTx: () => Promise.resolve(),
      enqueueDetached: () => new Promise(() => {}), // never settles
    };
    const slow = createBudgetAlertSink(notify);
    const started = Date.now();
    slow.budgetExceeded(base);
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe('dispatcher wiring', () => {
  it('does not overlap ticks when one runs long', async () => {
    // A slow SMTP server must not stack workers on top of each other.
    const { createDispatcher } = await import('../services/dispatcher.js');
    let inFlight = 0;
    let maxConcurrent = 0;
    const db = {
      withTenant: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return [];
      },
    } as never;
    const dispatcher = createDispatcher({
      db,
      masterKey: 'k',
      platformSender: createConsoleSender(),
      platformFrom: 'r@localhost',
      intervalMs: 5,
    });
    dispatcher.start();
    await new Promise((r) => setTimeout(r, 60));
    dispatcher.stop();
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  /**
   * The fan-out case. One notification, two chat channels, and only one of them working.
   *
   * A scripted fake stands in for Postgres, routing on the SQL text so the assertions are about the
   * dispatcher's decisions rather than about a schema.
   */
  async function runFanOut(webhookResponses: Record<string, number>, deliveredTo: string[] = []) {
    const { createDispatcher } = await import('../services/dispatcher.js');
    const { sealCredential } = await import('../../../platform/crypto.js');
    const masterKey = Buffer.alloc(32, 7).toString('base64');

    const sealedFor = (url: string) => {
      const s = sealCredential(masterKey, url);
      return {
        ciphertext: s.ciphertext,
        iv: s.iv,
        auth_tag: s.authTag,
        wrapped_dek: s.wrappedDek,
      };
    };

    const writes: { sql: string; values: unknown[] }[] = [];
    let claimed = false;
    const db = {
      withTenant: (_org: string, _scope: unknown, fn: (tx: unknown) => unknown) =>
        Promise.resolve(
          fn({
            run: (q: { text: string; values: unknown[] }) => {
              const sql = q.text;
              if (sql.includes("SET status = 'sending'")) {
                if (claimed) return Promise.resolve([]);
                claimed = true;
                return Promise.resolve([
                  {
                    id: 'n1',
                    org_id: 'org-1',
                    event_type: 'budget.exceeded',
                    payload: {},
                    dedupe_key: null,
                    status: 'sending',
                    attempts: 1,
                    next_attempt_at: '',
                    last_error: null,
                    recipients: [],
                    delivered_to: deliveredTo,
                    created_at: '',
                    sent_at: null,
                  },
                ]);
              }
              if (sql.includes('AS org_name')) return Promise.resolve([{ org_name: 'Acme' }]);
              if (sql.includes('notification_preferences')) {
                return Promise.resolve([{ enabled: true, recipients: [] }]);
              }
              if (sql.includes('FROM notification_channels')) {
                return Promise.resolve([
                  {
                    type: 'slack_webhook',
                    from_address: null,
                    config: {},
                    ...sealedFor('https://hooks.slack.com/services/A/B/ccccdddd'),
                  },
                  {
                    type: 'msteams_webhook',
                    from_address: null,
                    config: {},
                    ...sealedFor('https://acme.webhook.office.com/webhookb2/x/IncomingWebhook/y/z'),
                  },
                ]);
              }
              if (sql.includes('logto_org_id')) return Promise.resolve([]);
              writes.push({ sql, values: q.values });
              return Promise.resolve([]);
            },
          }),
        ),
    } as never;

    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      const host = new URL(url).hostname;
      calls.push(host);
      const status = webhookResponses[host] ?? 200;
      return Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve('nope'),
      });
    });

    const dispatcher = createDispatcher({
      db,
      masterKey,
      platformSender: createConsoleSender(),
      platformFrom: 'r@localhost',
    });
    await dispatcher.tick();
    vi.unstubAllGlobals();
    return { writes, calls };
  }

  it('posts to every configured chat channel and marks the row sent', async () => {
    const { writes, calls } = await runFanOut({});

    expect(calls.sort()).toEqual(['acme.webhook.office.com', 'hooks.slack.com']);
    const sent = writes.find((w) => w.sql.includes("status = 'sent'"));
    expect(sent).toBeDefined();
    expect(sent?.values[2]).toEqual(['slack_webhook', 'msteams_webhook']);
  });

  it('records the channel that succeeded before retrying the one that failed', async () => {
    // Teams is down. Without persisting the Slack success first, the retry would post to Slack
    // again — the tenant gets the same alert once per attempt from the healthy channel.
    const { writes } = await runFanOut({ 'acme.webhook.office.com': 500 });

    const progress = writes.find(
      (w) => w.sql.includes('delivered_to = $3') && !w.sql.includes("'sent'"),
    );
    expect(progress?.values[2]).toEqual(['slack_webhook']);

    const retry = writes.find((w) => w.sql.includes('next_attempt_at = now()'));
    expect(String(retry?.values[1])).toContain('msteams_webhook');
    expect(String(retry?.values[1])).not.toContain('slack_webhook');
  });

  it('skips a channel that already received this notification', async () => {
    // Resuming a retry: Slack is in delivered_to, so only Teams is attempted.
    const { calls } = await runFanOut({}, ['slack_webhook']);
    expect(calls).toEqual(['acme.webhook.office.com']);
  });

  it('survives a database failure during claim without throwing', async () => {
    const { createDispatcher } = await import('../services/dispatcher.js');
    const db = { withTenant: () => Promise.reject(new Error('pg down')) } as never;
    const dispatcher = createDispatcher({
      db,
      masterKey: 'k',
      platformSender: createConsoleSender(),
      platformFrom: 'r@localhost',
    });
    await expect(dispatcher.tick()).resolves.toBe(0);
  });
});
