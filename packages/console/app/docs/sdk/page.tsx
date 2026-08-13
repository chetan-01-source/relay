/**
 * SDK reference.
 *
 * Opens by telling people they may not need it. A gateway's credibility rests on being a drop-in,
 * and burying "the OpenAI SDK already works" under a pitch for our own package would undercut the
 * main claim of the product to sell a dependency.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { DocBody, DocHeader, DocList, DocSection } from '../../../components/docs/doc-page';
import { CodeBlock, Callout } from '../../../components/docs/code-block';

export const metadata: Metadata = {
  title: 'TypeScript SDK — Relay Gateway docs',
  description:
    '@relay/sdk: chat completions with typed Relay metadata, plus a typed control-plane client.',
};

export default function SdkDocsPage() {
  return (
    <>
      <DocHeader
        eyebrow="Integrate"
        title="TypeScript SDK"
        lede="@relay/sdk is a zero-dependency client for Node 18+, Bun, Deno, Cloudflare Workers and browsers. It exists for the two things a stock OpenAI client cannot do."
      />

      <DocBody>
        <DocSection id="do-you-need-it" title="Do you need it?">
          <p>
            Probably not for chat alone. Relay implements the OpenAI Chat Completions API, so the
            official <code>openai</code> package works against it with a base URL and a key changed
            — and that path stays first-class.
          </p>
          <p>Reach for this package when you want:</p>
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>Relay&apos;s per-request metadata as typed fields.</strong> Which provider
              served it, what it cost, whether it was cached or failed over, its trace id, the plan
              enforcing the ceilings. With <code>openai</code> those live behind{' '}
              <code>withResponse()</code> as untyped strings.
            </li>
            <li>
              <strong>The control plane from code.</strong> Applications, keys, providers, routes,
              budgets, analytics, audit and plan — so provisioning a tenant is a script.
            </li>
          </ul>
        </DocSection>

        <DocSection id="install" title="Install">
          <CodeBlock label="shell" code={`npm i @relay/sdk`} />
        </DocSection>

        <DocSection id="chat" title="Chat">
          <CodeBlock
            label="typescript"
            code={`import { Relay } from '@relay/sdk';

const relay = new Relay({
  baseUrl: 'https://relay.acme.internal',
  apiKey: process.env.RELAY_API_KEY!, // rk_live_…
});

const res = await relay.chat.completions.create({
  model: 'fast',                       // your alias, not a vendor's
  messages: [{ role: 'user', content: 'hello' }],
});

res.choices[0].message.content;
res.relay.provider;    // 'anthropic'
res.relay.costUsd;     // 0.000412 — metered, not estimated
res.relay.cached;      // false
res.relay.failover;    // true if the first target was down
res.relay.traceId;     // '8f2c…'
res.relay.plan;        // 'pro'
res.relay.rateLimit.remainingRequests;  // 599`}
          />
          <Callout>
            <p>
              Every field of <code>res.relay</code> is <code>null</code> when the gateway did not
              report it. An older gateway with a newer SDK degrades to <code>costUsd === null</code>{' '}
              — never a throw, and never a fabricated <code>0</code> that would quietly corrupt
              whatever you are summing.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="streaming" title="Streaming">
          <CodeBlock
            label="typescript"
            code={`const stream = await relay.chat.completions.stream({ model: 'fast', messages });

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}

const meta = await stream.relay;
// or, if you only want the finished text:
const text = await stream.text();`}
          />
          <p>
            A failure <strong>before the first token</strong> — a tripped budget, an unreachable
            provider — throws from <code>stream()</code> itself, which is where your{' '}
            <code>try/catch</code> actually is. Failures mid-stream end the stream cleanly.
          </p>
          <Callout tone="warning" title="Cost on a stream">
            <p>
              Token usage arrives in the final SSE frame, <em>after</em> the response headers are
              sent, so <code>x-relay-cost-usd</code> on a stream reflects only what was known at
              header time — often <code>0.000000</code>. The settled cost always lands on the
              metered usage event and the analytics rollups. Do not build billing on the streaming
              header.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="errors" title="Errors">
          <p>
            Every non-2xx becomes a <code>RelayApiError</code> carrying the catalog code, so you
            branch on meaning rather than on a status number.
          </p>
          <CodeBlock
            label="typescript"
            code={`import { RelayApiError } from '@relay/sdk';

try {
  await relay.chat.completions.create({ model: 'fast', messages });
} catch (err) {
  if (err instanceof RelayApiError) {
    switch (err.code) {
      case 'budget_exceeded':       break;  // the org's spend ceiling is reached
      case 'rate_limited':          break;  // err.retryAfterSeconds
      case 'quota_exceeded':        break;  // err.param names the plan quota
      case 'plan_upgrade_required': break;  // err.param names the capability
    }
    console.error(err.traceId);             // correlate with Live traffic
  }
}`}
          />
        </DocSection>

        <DocSection id="retries" title="Retries">
          <p>
            Off by default. When enabled, only <code>429</code>/<code>502</code>/<code>503</code>{' '}
            are retried, <code>retry-after</code> is honoured, and a request that has already
            streamed a byte is <strong>never</strong> re-sent — retrying a partially-consumed
            completion bills you twice for one answer.
          </p>
          <CodeBlock
            label="typescript"
            code={`new Relay({ baseUrl, apiKey, retry: { attempts: 3 } });`}
          />
        </DocSection>

        <DocSection id="admin" title="Control plane">
          <p>
            Authenticated with a Logto access token, not a virtual key — a separate client on
            purpose, so an admin token cannot end up in code that only needed to send a completion.
          </p>
          <CodeBlock
            label="typescript"
            code={`const admin = relay.admin(await getLogtoAccessToken());

const app = await admin.apps.create({ name: 'checkout-service' });
const key = await admin.apps.keys.issue(app.id, { environment: 'live' });
key.key;   // rk_live_… — returned ONCE

await admin.budgets.setForApp(app.id, 'monthly', { limit_usd: 200, hard_cutoff: true });

const plan = await admin.plan.get();
plan.limits['apps.max'];   // { value: 10, source: 'plan', used: 4 }`}
          />
          <DocList
            rows={[
              { term: 'admin.me', detail: 'Who this token is and which organization it acts as.' },
              {
                term: 'admin.apps',
                detail: 'Applications, and apps.keys for issue / rotate / revoke.',
              },
              { term: 'admin.providers', detail: 'Sealed upstream credentials.' },
              {
                term: 'admin.routes',
                detail:
                  'Routes, immutable versions, and activation (rollback is activating an older one).',
              },
              { term: 'admin.budgets', detail: 'Org-wide and per-application spend ceilings.' },
              { term: 'admin.analytics', detail: 'Usage and spend over the hourly rollups.' },
              {
                term: 'admin.traffic',
                detail: 'The recent request feed and one request’s detail.',
              },
              { term: 'admin.audit', detail: 'The hash-chained trail, and the verify endpoint.' },
              {
                term: 'admin.plan',
                detail: (
                  <>
                    Effective limits with provenance and usage — the same payload the{' '}
                    <Link href="/docs/plans">plan page</Link> renders.
                  </>
                ),
              },
            ]}
          />
          <p>
            Every request and response type is projected out of the gateway&apos;s own OpenAPI
            document, so the client cannot drift from the server.
          </p>
        </DocSection>

        <DocSection id="browser" title="Why the browser is refused">
          <p>
            Constructing <code>Relay</code> in a browser throws. A virtual key is a server-side
            credential: anything shipped to the browser is readable by every visitor and can be
            spent against your providers. Call Relay from your server. If a key genuinely is public
            — a demo, a key under a budget you are content to lose — pass{' '}
            <code>dangerouslyAllowBrowser: true</code>.
          </p>
        </DocSection>

        <DocSection id="versioning" title="Versioning">
          <p>
            The SDK&apos;s minor tracks the gateway&apos;s (<code>0.2.x</code> ↔ <code>0.2.x</code>
            ); patches are independent. It sends <code>x-relay-sdk: ts/&lt;version&gt;</code> so a
            deployment can see its client-version spread, and tolerates unknown response fields and
            missing headers in both directions.
          </p>
        </DocSection>
      </DocBody>
    </>
  );
}
