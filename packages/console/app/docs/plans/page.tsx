/**
 * Plans & quotas.
 *
 * Written as an ENFORCEMENT reference, not a price list. Somebody reading this has usually just been
 * refused, and the question is "what refused me, why, and what makes it stop" — the tiers table
 * belongs on the pricing page, and the two live in different places on purpose.
 *
 * The self-hosted paragraph is first because it makes the rest of the page irrelevant for a large
 * share of readers, and wasting their time would be the worse outcome.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { DocBody, DocHeader, DocSection } from '../../../components/docs/doc-page';
import { CodeBlock, Callout } from '../../../components/docs/code-block';
import { Screenshot } from '../../../components/docs/screenshot';

export const metadata: Metadata = {
  title: 'Plans & quotas — Relay Gateway docs',
  description:
    'Every limit Relay enforces, where it is enforced, and what it returns. Unlimited in the self-hosted edition.',
};

const ENFORCEMENT: Array<{ key: string; where: string; result: string }> = [
  {
    key: 'apps.max',
    where: 'creating an application — inside the insert transaction',
    result: '409 quota_exceeded',
  },
  {
    key: 'providers.max',
    where: 'storing a provider credential',
    result: '409 quota_exceeded',
  },
  { key: 'routes.max', where: 'creating a route', result: '409 quota_exceeded' },
  {
    key: 'keys.per_app.max',
    where: 'issuing a key — counts active keys only, so rotating never consumes a slot',
    result: '409 quota_exceeded',
  },
  {
    key: 'members.max',
    where: 'inviting a member',
    result: '409 quota_exceeded',
  },
  {
    key: 'rate.rpm · rate.tpm',
    where: 'every request — a token bucket in Valkey, per key',
    result: '429 rate_limited with retry-after',
  },
  {
    key: 'spend.monthly_usd.max',
    where: 'every request — reserved before the upstream call, settled after',
    result: '429 budget_exceeded',
  },
  {
    key: 'retention.traffic_days',
    where: 'an hourly sweep over the request feed',
    result: 'requests past the window stop being inspectable',
  },
  {
    key: 'cache.exact',
    where: 'the cache lookup is skipped entirely',
    result: 'served uncached — no error',
  },
  {
    key: 'routing.failover',
    where: 'the route resolves to its first target only',
    result: 'that target’s failure surfaces as 502',
  },
  {
    key: 'modalities.image',
    where: 'image content parts, rejected before the upstream call',
    result: '403 plan_upgrade_required',
  },
  {
    key: 'notifications.chat',
    where: 'saving a Slack or Teams channel — email is always included',
    result: '403 plan_upgrade_required',
  },
  {
    key: 'analytics.export',
    where: 'the console’s CSV download',
    result: '403 plan_upgrade_required',
  },
];

export default function PlansDocsPage() {
  return (
    <>
      <DocHeader
        eyebrow="Operate"
        title="Plans & quotas"
        lede="A plan is a named bundle of limits. This page lists every limit that exists, the single place each one is enforced, and exactly what a caller gets back when it bites."
      />

      <DocBody>
        <DocSection id="mvp" title="Free during the MVP">
          <Callout title="Nothing on this page is currently billed or enforced">
            <p>
              Relay is <strong>free for everyone</strong> while we are in MVP. Every organization —
              hosted or self-hosted — resolves to unlimited limits with every capability included,
              so no quota below can refuse a request today.
            </p>
            <p className="mt-2">
              This page is kept as the reference for how the plan layer behaves, because it is
              built, tested and shipping — it is simply switched off. When that changes, it changes
              here first and you will not find out from a rejected request.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="self-hosted" title="Self-hosting? None of this applies">
          <p>
            In the open-source edition every organization resolves to the built-in{' '}
            <code>self_hosted</code> plan: every numeric limit unlimited, every capability included,
            every quota check a no-op. Nobody running their own copy is limited by code written to
            sell something. The <Link href="/plan">Plan &amp; usage</Link> screen still works there
            — it reports real counts against &ldquo;Unlimited&rdquo;, which is useful capacity
            information.
          </p>
        </DocSection>

        <DocSection id="resolution" title="Where a limit comes from">
          <p>Three layers resolve into one effective value, most specific winning:</p>
          <CodeBlock
            label="precedence"
            copyable={false}
            code={`plan.limits  ⊕  per-contract overrides  ⊕  organization feature flags  =  effective`}
          />
          <p>
            <code>GET /api/v1/plan</code> returns the value <em>and its provenance</em> for every
            key, so the console can say &ldquo;600 rpm — from plan Pro&rdquo; rather than asking
            anyone to remember this order.
          </p>
          <CodeBlock
            label="GET /api/v1/plan"
            copyable={false}
            code={`{
  "plan":   { "code": "pro", "name": "Pro", "tier": 2 },
  "status": "active",
  "lapsed": false,
  "limits": {
    "apps.max":    { "value": 10,   "source": "plan",     "used": 4 },
    "members.max": { "value": 25,   "source": "override", "used": 12 },
    "rate.rpm":    { "value": 600,  "source": "plan" },
    "cache.exact": { "value": true, "source": "plan" }
  }
}`}
          />
        </DocSection>

        <DocSection id="watching" title="Watching what you spend">
          <p>
            Quotas are the ceiling; the console&apos;s <strong>Usage &amp; spend</strong> screen is
            where you find out how close you are. It reads the hourly rollups — the same source the
            budget screens use — so the two can never disagree.
          </p>
          <Screenshot
            src="/docs/console-usage.png"
            alt="The Usage and spend screen: a Group by segmented control offering Model, Application, Route and Day; UTC from/to date pickers; an Export CSV button; stat tiles for spend, requests, tokens and top bucket; a daily spend chart; and a breakdown table by model with requests, input tokens, output tokens and cost."
            caption="Grouping and the date window both live in the URL, so any view here is a link you can paste into an incident channel. Dates are UTC because the rollups are bucketed in UTC — a request just after local midnight lands in the previous UTC day."
          />
        </DocSection>

        <DocSection id="enforcement" title="Every limit, and where it bites">
          <p>
            Each limit has exactly one authoritative enforcement point. Nothing below is
            advisory-only, and nothing outside this list is claimed anywhere in the product.
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[42rem] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="px-4 py-2.5 font-medium text-foreground">Limit</th>
                  <th className="px-4 py-2.5 font-medium text-foreground">Enforced</th>
                  <th className="px-4 py-2.5 font-medium text-foreground">On breach</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ENFORCEMENT.map((row) => (
                  <tr key={row.key}>
                    <td className="px-4 py-3 align-top font-mono text-xs text-foreground">
                      {row.key}
                    </td>
                    <td className="px-4 py-3 align-top leading-relaxed">{row.where}</td>
                    <td className="px-4 py-3 align-top font-mono text-xs">{row.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Callout title="Two limits you might expect, and why they are absent">
            <p className="mb-2">
              <strong>Audit retention.</strong> The audit trail is hash-chained and append-only.
              Deleting old entries would break the verify endpoint for everything after them, so
              selling a shorter audit window would mean selling a broken guarantee. Audit history is
              kept in full on every plan.
            </p>
            <p>
              <strong>Enforced SSO.</strong> That is identity-provider configuration, not a gateway
              decision, so the gateway has nowhere to honour such a flag. It stays a contractual
              term rather than a switch that pretends to be enforced.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="composition" title="How plan limits combine with your own">
          <p>
            You can still set your own rate limits and budgets. Under a plan those compose as a{' '}
            <strong>minimum</strong>, never a maximum:
          </p>
          <ul className="ml-5 list-disc space-y-2">
            <li>Lowering your own limit below the plan always works and is always honoured.</li>
            <li>
              Raising it above the plan is accepted by the API and simply not honoured — the console
              shows both numbers and marks which is binding.
            </li>
            <li>
              The plan&apos;s monthly spend cap is applied as an additional org-wide ceiling with a
              hard cutoff, on top of whatever budgets you set.
            </li>
          </ul>
          <p>
            That is what makes a downgrade safe: nothing has to be rewritten, enforcement simply
            tightens.
          </p>
        </DocSection>

        <DocSection id="errors" title="What a rejection looks like">
          <CodeBlock
            label="409 — a countable quota is full"
            copyable={false}
            code={`{
  "error": {
    "type": "invalid_request_error",
    "code": "quota_exceeded",
    "param": "apps.max",
    "message": "Plan pro allows 10 applications; this organization has 10."
  }
}`}
          />
          <CodeBlock
            label="403 — the plan excludes the capability"
            copyable={false}
            code={`{
  "error": {
    "type": "permission_error",
    "code": "plan_upgrade_required",
    "param": "modalities.image",
    "message": "Image inputs are not included in this organization's plan."
  }
}`}
          />
          <p>
            Both arrive in the same OpenAI-compatible envelope as every other Relay error, so any
            OpenAI SDK surfaces them as ordinary API errors — and{' '}
            <Link href="/docs/sdk#errors">@relay-ai/sdk</Link> exposes <code>err.code</code> and{' '}
            <code>err.param</code> directly.
          </p>
        </DocSection>

        <DocSection id="downgrades" title="Trials, lapses and downgrades">
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>Trials expire when read</strong>, not on a schedule — the moment the end date
              passes, free-tier limits apply everywhere. The subscription keeps reporting{' '}
              <code>trialing</code> so the console can explain why rather than silently showing
              Free.
            </li>
            <li>
              <strong>A failed payment keeps your limits</strong> for a grace window. Cutting a
              production gateway off over a card decline is the worse failure.
            </li>
            <li>
              <strong>A downgrade deletes nothing.</strong> An organization with 40 applications
              that moves to a 10-application plan keeps all 40; it simply cannot create the 41st,
              and the plan page lists what is over.
            </li>
            <li>
              Every change is an <strong>audit event</strong>, appended in the same transaction as
              the write.
            </li>
          </ul>
        </DocSection>
      </DocBody>
    </>
  );
}
