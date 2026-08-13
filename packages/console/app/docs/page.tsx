/**
 * Docs overview.
 *
 * The job of this page is to get somebody off it quickly. It states what Relay is in two sentences,
 * shows the smallest thing that proves it works, and then routes to the four pages that matter. No
 * marketing copy — anyone who reached /docs has already decided to evaluate.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Gauge,
  Package,
  ServerCog,
  TriangleAlert,
} from 'lucide-react';
import { DocBody, DocHeader, DocSection } from '../../components/docs/doc-page';
import { CodeBlock } from '../../components/docs/code-block';
import { Screenshot } from '../../components/docs/screenshot';
import { Card, CardContent } from '../../components/ui/card';

export const metadata: Metadata = {
  title: 'Documentation — Relay Gateway',
  description:
    'Point an OpenAI client at Relay and get routing with failover, spend ceilings, per-tenant isolation and an audit trail.',
};

const ROUTES = [
  {
    href: '/docs/quickstart',
    icon: Boxes,
    title: 'Quickstart',
    body: 'From nothing to a proxied call: a provider, a route, an application, a key.',
  },
  {
    href: '/docs/sdk',
    icon: Package,
    title: 'TypeScript SDK',
    body: '@relay-ai/sdk — chat with typed metadata, plus the whole control plane from code.',
  },
  {
    href: '/docs/plans',
    icon: Gauge,
    title: 'Plans & quotas',
    body: 'Which limits exist, where each is enforced, and what it returns when it bites.',
  },
  {
    href: '/docs/self-host',
    icon: ServerCog,
    title: 'Self-hosting',
    body: 'Three containers and a master key. Everything stays in your infrastructure.',
  },
];

export default function DocsOverviewPage() {
  return (
    <>
      <DocHeader
        eyebrow="Documentation"
        title="Relay Gateway"
        lede="Relay sits between your application and the model providers. It speaks the OpenAI Chat Completions API, so your SDK does not change — what changes is that every request is routed, budgeted, metered, isolated and recorded."
      />

      <DocBody>
        <DocSection id="what-you-get" title="What you get">
          <Screenshot
            src="/docs/console-dashboard.png"
            alt="The Relay console dashboard: stat tiles for spend, requests, tokens and top model; a daily spend chart built from the hourly usage rollups; a setup checklist showing all four steps complete; and a spend-by-model table."
            caption="The console after the first few requests. Spend is computed per request from rate cards, not estimated — the same figures the analytics export and the budget enforcement read."
            priority
          />
          <p>
            The left nav is the order you actually work in: <strong>Build</strong> what traffic
            flows through, <strong>Operate</strong> what it costs and who changed it, and — for
            platform operators — <strong>Platform</strong> across every tenant.
          </p>
        </DocSection>

        <DocSection id="two-lines" title="The whole migration">
          <p>
            Point the client at your Relay deployment and swap the key. Streaming, tool calls and
            response shapes are unchanged, because Relay forwards them.
          </p>
          <CodeBlock
            label="python"
            code={`client = OpenAI(
-    base_url="https://api.openai.com/v1",
-    api_key=OPENAI_KEY,
+    base_url="https://relay.acme.internal/v1",
+    api_key=RELAY_VIRTUAL_KEY,
)`}
          />
          <p>
            <code>model</code> is now <strong>your</strong> alias — <code>fast</code>,{' '}
            <code>cheap</code>, <code>long-context</code> — and the route behind it decides which
            provider actually serves the request.
          </p>
        </DocSection>

        <DocSection id="where-next" title="Where to go next">
          <div className="grid gap-4 sm:grid-cols-2">
            {ROUTES.map(({ href, icon: Icon, title, body }) => (
              <Link key={href} href={href} className="group rounded-lg focus-visible:outline-none">
                <Card className="h-full cursor-pointer transition-colors group-hover:border-primary/40 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                  <CardContent className="p-5">
                    <span className="inline-flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <p className="mt-4 flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {title}
                      <ArrowRight
                        className="size-3.5 transition-transform group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </p>
                    <p className="mt-2 text-sm leading-relaxed">{body}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </DocSection>

        <DocSection id="concepts" title="The five nouns">
          <p>
            Everything in the console and the API is one of these. Learning them in order is the
            fastest way through the product.
          </p>
          <dl className="divide-y rounded-lg border">
            {[
              [
                'Organization',
                'The tenant boundary. Isolation is enforced by Postgres row-level security, not by a WHERE clause somebody has to remember.',
              ],
              [
                'Provider',
                'An upstream credential — OpenAI, Anthropic, or anything OpenAI-compatible. Sealed on write; no read path ever returns it.',
              ],
              [
                'Route',
                'A model alias fanned out to an ordered set of targets. Versions are immutable, so rollback is activating an older one.',
              ],
              [
                'Application',
                'A thing that calls the gateway. It owns its virtual keys and can carry its own budget.',
              ],
              [
                'Virtual key',
                'What your client actually holds: rk_live_… , scoped to one application, rotatable with a grace window and revocable in about a second.',
              ],
            ].map(([term, detail]) => (
              <div
                key={term}
                className="grid gap-1 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
              >
                <dt className="text-sm font-medium text-foreground">{term}</dt>
                <dd className="text-sm leading-relaxed">{detail}</dd>
              </div>
            ))}
          </dl>
        </DocSection>

        <DocSection id="honesty" title="What Relay is not">
          <p className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
            <span>
              Not a prompt framework, an agent runtime or an eval harness. It is the layer that
              makes model traffic governable — routing, spend, keys, isolation and a record of what
              happened. Everything above that belongs in your application.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              The design decisions behind each subsystem are written down as ADRs in the repository,
              not summarised here — this section documents behaviour, the ADRs document why.
            </span>
          </p>
        </DocSection>
      </DocBody>
    </>
  );
}
