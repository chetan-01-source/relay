/**
 * Quickstart.
 *
 * Ordered by DEPENDENCY, not by menu order: a key is useless without an application, an application
 * without a route, a route without a provider. Following the console's nav order instead would send
 * a first-time user round a loop, which is how most gateway quickstarts fail.
 *
 * Every step names the console screen AND the equivalent API/SDK call, because the two audiences for
 * this page — someone clicking through once, and someone scripting it for every customer — are both
 * here and neither should have to translate.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { DocBody, DocHeader, DocSection } from '../../../components/docs/doc-page';
import { CodeBlock, Callout } from '../../../components/docs/code-block';
import { Screenshot } from '../../../components/docs/screenshot';

export const metadata: Metadata = {
  title: 'Quickstart — Relay Gateway docs',
  description: 'From nothing to a proxied completion: provider, route, application, key.',
};

interface Step {
  title: string;
  where: string;
  body: string;
  /** Not every step has a screen worth showing — issuing a key is a dialog, a budget is two fields. */
  shot?: { src: string; alt: string; caption: string };
}

const STEPS: Step[] = [
  {
    title: 'Store a provider credential',
    where: 'Build → Providers',
    body: 'Paste your OpenAI or Anthropic key. It is sealed with envelope encryption on write and never returned by any read path — the console shows only the last four characters.',
    shot: {
      src: '/docs/console-providers.png',
      alt: 'The Providers screen: an "Add a credential" form with name, provider and secret-key fields, above a table of stored credentials showing only the last four characters of each secret, its status and a routing-health percentage.',
      caption:
        'The secret field is write-only. Once saved, the table can show you that a credential exists and how healthy it is — never what it is.',
    },
  },
  {
    title: 'Create a route',
    where: 'Build → Routes',
    body: 'A route maps an alias you choose (fast) to an ordered list of targets. Put a second target below the first and you have failover; the response tells you when it fired.',
    shot: {
      src: '/docs/console-routes.png',
      alt: 'The Routes screen: a "New route" form with a model-alias field, an exact-cache toggle, a scope selector reading "Whole organization", and a target row with credential, model, priority and weight — above a table of existing routes.',
      caption:
        'Priority orders failover; weight splits traffic within a priority. A route scoped to one application overrides the organization’s route for that alias.',
    },
  },
  {
    title: 'Create an application',
    where: 'Build → Applications',
    body: 'One per service that calls the gateway. This is the unit budgets, keys and usage attribution hang off, so a per-service split now saves an untangling later.',
    shot: {
      src: '/docs/console-applications.png',
      alt: 'The Applications screen: a "New application" form with name and description, and a table of existing applications each with a "Manage keys" button.',
      caption:
        'Keys are issued from an application, not from a provider — which is what lets you revoke one service without touching another.',
    },
  },
  {
    title: 'Issue a virtual key',
    where: 'the application’s page',
    body: 'The plaintext rk_live_… is shown exactly once. Relay stores a verifier, not the secret, so it genuinely cannot be shown again — copy it into your secret store now.',
  },
  {
    title: 'Set a budget',
    where: 'Operate → Budgets',
    body: 'Optional, and the one step nobody regrets. A monthly ceiling with a hard cutoff is enforced before the upstream call, not reconciled after the invoice.',
  },
];
export default function QuickstartPage() {
  return (
    <>
      <DocHeader
        eyebrow="Getting started"
        title="Quickstart"
        lede="Five steps from an empty organization to a proxied completion. Roughly ten minutes in the console, or one script with the SDK."
      />

      <DocBody>
        <DocSection id="steps" title="The five steps">
          {/* An ordered list, not headings: the sequence IS the content, and a screen reader
              announcing "list item 2 of 5" tells you exactly where you are in a setup flow. */}
          <ol className="space-y-8">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <div className="flex gap-4">
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 font-mono text-xs font-medium tabular-nums text-primary">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {step.title}{' '}
                      <span className="font-normal text-muted-foreground">— {step.where}</span>
                    </p>
                    <p className="mt-1 text-sm leading-relaxed">{step.body}</p>
                  </div>
                </div>
                {step.shot ? (
                  // Indented to the prose, so the image reads as belonging to its step rather than
                  // floating between two of them.
                  <div className="ml-11">
                    <Screenshot {...step.shot} priority={index === 0} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </DocSection>

        <DocSection id="first-call" title="Your first call">
          <p>
            Nothing Relay-specific in the request — this is the OpenAI Chat Completions API. What is
            Relay-specific is what comes back in the headers.
          </p>
          <CodeBlock
            label="curl"
            code={`curl https://relay.acme.internal/v1/chat/completions \\
  -H "authorization: Bearer rk_live_…" \\
  -H "content-type: application/json" \\
  -d '{"model":"fast","messages":[{"role":"user","content":"hello"}]}'`}
          />
          <CodeBlock
            label="response headers"
            copyable={false}
            code={`x-relay-provider: anthropic
x-relay-failover: true
x-relay-cache: miss
x-relay-cost-usd: 0.000412
x-relay-trace-id: 8f2c…
x-relay-plan: pro`}
          />
          <p>
            That <code>x-relay-trace-id</code> is the key the console&apos;s{' '}
            <strong>Live traffic</strong> view is indexed on, so any request you can see in a log
            you can also open in the UI.{' '}
            <Link href="/docs/errors">Every header is listed here.</Link>
          </p>
        </DocSection>

        <DocSection id="scripted" title="The same thing, scripted">
          <p>
            Provisioning one tenant per customer is the case the SDK exists for. Each call below is
            the API the console screen above uses.
          </p>
          <CodeBlock
            label="typescript"
            code={`import { Relay } from '@relay/sdk';

const relay = new Relay({ baseUrl, apiKey: 'rk_live_…' });
const admin = relay.admin(await getLogtoAccessToken());

await admin.providers.create({ name: 'openai-prod', provider: 'openai', api_key: process.env.OPENAI_KEY! });
await admin.routes.create({ model_name: 'fast', targets: [{ provider: 'openai', model: 'gpt-4o-mini', priority: 1 }] });

const app = await admin.apps.create({ name: 'checkout-service' });
await admin.budgets.setForApp(app.id, 'monthly', { limit_usd: 200, hard_cutoff: true });

const { key } = await admin.apps.keys.issue(app.id, { environment: 'live' });
// 'key' is the plaintext, returned once. Store it now.`}
          />
        </DocSection>

        <DocSection id="verify" title="Checking it works">
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>Live traffic</strong> shows the request within a second, with its provider,
              latency and cost.
            </li>
            <li>
              <strong>Usage &amp; spend</strong> shows it after the next hourly rollup — the two
              screens read different sources on purpose, and both are correct for what they measure.
            </li>
            <li>
              <strong>Audit</strong> shows every configuration change you just made, hash-chained,
              with a verify endpoint.
            </li>
          </ul>
          <Screenshot
            src="/docs/console-traffic.png"
            alt="The Live traffic screen: filter tabs for All, OK, Error, Rate limited and Budget exceeded, a live indicator, and a table of recent requests with time, model, route, application, provider, status, tokens, cost, latency and request id. Two rows show a budget_exceeded status; several show a cache provider with zero cost."
            caption="Every request, newest first. The cache rows cost nothing and returned in about a millisecond; the budget_exceeded rows never reached a provider at all."
          />

          <Callout tone="warning" title="If the call is refused">
            <p>
              A <code>401</code> means the key is unknown or revoked; <code>403 org_suspended</code>{' '}
              means the organization is suspended; <code>429 budget_exceeded</code> means a ceiling
              is reached; <code>409 quota_exceeded</code> means a plan quota is full. Each is
              explained on <Link href="/docs/errors">Errors &amp; headers</Link>.
            </p>
          </Callout>
        </DocSection>
      </DocBody>
    </>
  );
}
