/**
 * The landing page — the first thing anyone sees, and for most people the only thing they read
 * before deciding whether to keep going.
 *
 * DESIGN NOTES (docs/UI-THEME.md, "Enterprise Gateway"):
 *
 *  • The two supplied references were adapted, not copied. From the SaaS template we took the shape
 *    of the hero — announcement pill → gradient headline → subcopy → one primary CTA → product
 *    proof. We dropped its `bg-black`, its Google-Fonts `@import` (render-blocking on the page with
 *    the tightest LCP budget), its hardcoded greys, and its `hover:scale-105`, which our system
 *    forbids because a scale hover shifts layout. Every colour here is a token, so the page has a
 *    real light mode rather than a dark page with the lights left on.
 *
 *  • From the sparkles reference we took the effect and rebuilt it dependency-free — see
 *    components/landing/sparkles.tsx for why.
 *
 *  • NO fabricated social proof. The design engine's pattern calls for a logo carousel and
 *    testimonials; on a v1.0 with no customers those would be invented, and a developer audience
 *    treats invented logos as a reason to close the tab. The proof here is technical and checkable:
 *    real endpoints, real headers, a real compose file. That is the honest version of credibility.
 *
 *  • Server-rendered end to end. The only client JavaScript is the mobile menu, the theme toggle,
 *    and the canvas. The FAQ is `<details>` — no JS, keyboard-accessible, works before hydration.
 */
import Link from 'next/link';
import { getLogtoContext } from '@logto/next/server-actions';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  Check,
  FileLock2,
  GitBranch,
  KeyRound,
  Package,
  ScrollText,
  ShieldCheck,
  Siren,
  Split,
  Terminal,
  Wallet,
} from 'lucide-react';
import { logtoConfig, logtoConfigured } from './lib/logto';
import { isCloud } from './lib/edition';
import { signInAction } from './actions';
import { LandingNav } from '../components/landing/landing-nav';
// MVP-FREE: restore alongside the pricing section below.
// import { Pricing } from '../components/landing/pricing';
import { SparklesBand, SparklesWordmark } from '../components/landing/sparkles-band';
import { RelayMark } from '../components/brand/relay-logo';
import { Button } from '../components/ui/button';
import { FeatureCard } from '../components/ui/feature-card';
import { Card, CardContent } from '../components/ui/card';

// Auth state is per-request (reads cookies) — never statically prerender.
export const dynamic = 'force-dynamic';

/** Capabilities, in the order someone evaluating a gateway actually asks about them. */
const CAPABILITIES = [
  {
    icon: Split,
    title: 'Routing with failover',
    body: 'One model alias fans out to an ordered or weighted set of upstream targets. A dead provider fails over mid-request. Versions are immutable, so rollback is activating an older one.',
  },
  {
    icon: Wallet,
    title: 'Budgets that actually stop spend',
    body: 'Daily and monthly ceilings per organization and per application. Enforced on the hot path with a reserve/settle counter, not reconciled after the invoice arrives.',
  },
  {
    icon: KeyRound,
    title: 'Virtual keys, not provider keys',
    body: 'Clients hold rk_live_… keys scoped to one application. Rotate with a grace window, revoke instantly — every worker drops the key within about a second.',
  },
  {
    icon: FileLock2,
    title: 'A credential vault',
    body: 'Provider keys are sealed with envelope encryption and are write-only: no read path returns one, not the API, not the console, not the audit trail.',
  },
  {
    icon: BarChart3,
    title: 'Usage and spend you can query',
    body: 'Every request is metered and rolled up hourly — by application, route, model or day, in the console or as CSV. Cost is computed per request from rate cards.',
  },
  {
    icon: ScrollText,
    title: 'A tamper-evident audit trail',
    body: 'Every configuration change is appended to a hash-chained log with a verify endpoint, so "who raised that budget" has an answer that cannot be quietly edited.',
  },
  {
    icon: Siren,
    title: 'Alerts where your team already is',
    body: 'Budget breaches, revoked keys and membership changes reach email, Slack and Microsoft Teams. Channels are per organization and fail independently.',
  },
  {
    icon: Boxes,
    title: 'Multi-tenant to the row',
    body: 'Applications, keys, routes and budgets belong to an organization, isolated by Postgres row-level security rather than by a WHERE clause somebody has to remember.',
  },
];

const GOVERNANCE = [
  {
    title: 'Isolation is enforced by the database',
    body: 'Every tenant table has FORCE row-level security with a tenant policy bound to the current organization. A missing WHERE clause returns nothing instead of returning someone else’s data.',
  },
  {
    title: 'Secrets are sealed, never echoed',
    body: 'Provider keys, SMTP passwords and chat webhook URLs are encrypted with a per-record data key wrapped by your master key. Reads return whether a secret exists, never the value.',
  },
  {
    title: 'Roles inside each organization',
    body: 'Members read; administrators move budgets, store provider credentials and configure alert channels. The console hides those controls and the gateway independently rejects them.',
  },
  {
    title: 'Single sign-on, invitation-based access',
    body: 'Identity is Logto. Joining an organization always requires an invitation the invited address accepts — holding the link is not enough.',
  },
];

const FAQ = [
  {
    q: 'Do I have to change my application code?',
    a: 'Two lines: point the base URL at your Relay deployment and swap the key for a virtual key. Relay speaks the OpenAI Chat Completions API, including streaming, so existing SDKs work unchanged.',
  },
  {
    q: 'What happens when a provider goes down?',
    a: 'The route’s next target takes the request. Failover happens inside the same request, and the response carries an x-relay-failover header so you can see it happened.',
  },
  {
    q: 'Can a budget actually stop a runaway job?',
    a: 'Yes. Ceilings are enforced before the upstream call using an atomic counter, and a hard cutoff rejects with budget_exceeded rather than merely warning. A ceiling can also be set to track without blocking.',
  },
  {
    q: 'Where do provider credentials live?',
    a: 'In your Postgres, sealed with envelope encryption under a master key you hold. Relay is self-hosted — credentials and prompts never transit a service we operate.',
  },
  {
    q: 'What does it take to run?',
    a: 'Postgres, Valkey and the gateway container. The published compose file brings all three up, applies migrations and serves a readiness endpoint your orchestrator can gate on.',
  },
];

export default async function LandingPage() {
  // A signed-in visitor should never be asked to sign in again — the CTAs become "open console".
  let signedIn = false;
  if (logtoConfigured) {
    try {
      signedIn = (await getLogtoContext(logtoConfig)).isAuthenticated;
    } catch {
      signedIn = false;
    }
  }

  return (
    <>
      {/* Keyboard users land here first; the nav is fixed, so skipping past it must be possible. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <LandingNav signedIn={signedIn} showPricing={isCloud} />

      <main id="main" className="pt-16">
        {/* ── Hero ────────────────────────────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden px-6 pb-16 pt-16 md:pt-24">
          <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
              <span className="inline-flex size-1.5 rounded-full bg-primary" aria-hidden="true" />
              Relay v1.0 — self-hosted and production-ready
            </p>

            {/* The gradient headline from the reference, rebuilt on tokens so it reads correctly in
                both themes rather than assuming white-on-black. */}
            <h1 className="mt-6 bg-gradient-to-b from-foreground via-foreground to-foreground/55 bg-clip-text text-4xl font-semibold leading-[1.1] tracking-tight text-transparent md:text-6xl">
              One endpoint for every model.
              <br />
              Every request accounted for.
            </h1>

            <p className="mt-6 max-w-2xl text-base text-muted-foreground md:text-lg">
              Relay is a self-hosted, multi-tenant LLM gateway. Point your OpenAI client at it and
              get routing with failover, spend ceilings that hold, per-tenant isolation and an audit
              trail — without changing a line of application logic.
            </p>

            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
              {signedIn ? (
                <Button asChild size="lg">
                  <Link href="/dashboard">
                    Open console <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              ) : (
                <form action={signInAction}>
                  <Button type="submit" size="lg">
                    Get started <ArrowRight className="size-4" aria-hidden="true" />
                  </Button>
                </form>
              )}
              <Button asChild variant="outline" size="lg">
                <Link href="/docs/quickstart">Read the docs</Link>
              </Button>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              No account on our servers — Relay runs in your infrastructure.
            </p>
          </div>

          {/* The sparkles band — tsparticles, loaded lazily. See components/landing/sparkles-band. */}
          <SparklesBand />

          {/* Product proof: the actual request, and the actual headers that come back. */}
          <div className="mx-auto mt-2 w-full max-w-3xl">
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-mono text-xs text-muted-foreground">
                  the request you already make
                </span>
              </div>
              <CardContent className="overflow-x-auto p-0">
                <pre className="p-4 font-mono text-xs leading-relaxed md:text-[13px]">
                  <code>
                    <span className="text-muted-foreground">$</span> curl
                    https://relay.acme.internal/v1/chat/completions \{'\n'}
                    {'  '}-H{' '}
                    <span className="text-primary">
                      &quot;authorization: Bearer rk_live_…&quot;
                    </span>{' '}
                    \{'\n'}
                    {'  '}-d &apos;&#123;&quot;model&quot;:
                    <span className="text-primary">&quot;fast&quot;</span>
                    ,&quot;messages&quot;:[…]&#125;&apos;
                    {'\n\n'}
                    <span className="text-muted-foreground">
                      {'< '}x-relay-provider: anthropic{'\n'}
                      {'< '}x-relay-failover: openai→anthropic{'\n'}
                      {'< '}x-relay-cost-usd: 0.000412{'\n'}
                      {'< '}x-relay-trace-id: 8f2c…{'\n'}
                    </span>
                  </code>
                </pre>
              </CardContent>
            </Card>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              <code className="font-mono">model</code> is your alias, not a vendor&apos;s. Relay
              picks the target, fails over, meters the cost and stamps the trace.
            </p>
          </div>
        </section>

        {/* ── Drop-in ─────────────────────────────────────────────────────────────────────────── */}
        <section className="border-y bg-muted/25 px-6 py-16">
          <div className="mx-auto grid max-w-5xl items-center gap-10 md:grid-cols-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                A two-line migration
              </h2>
              <p className="mt-3 text-sm text-muted-foreground md:text-base">
                Relay implements the OpenAI Chat Completions API, streaming included. Your SDK, your
                prompts and your response handling stay exactly as they are — you change where the
                client points and which key it carries.
              </p>
              <ul className="mt-6 space-y-2.5">
                {[
                  'Works with the official OpenAI SDKs, unmodified',
                  'Server-sent events pass straight through',
                  'Model discovery at /v1/models',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <Card className="overflow-hidden">
              <CardContent className="overflow-x-auto p-0">
                {/* The removed lines are de-emphasised rather than red. `--destructive` is tuned for
                    buttons and resolves to a very dark red in dark mode, which on a dark code
                    surface fails contrast — and a diff already reads as a diff from the -/+ gutter
                    and the emphasis. This also keeps the page to one accent. */}
                <pre className="p-4 font-mono text-xs leading-relaxed">
                  <code>
                    {' client = OpenAI(\n'}
                    <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                      {'-    base_url="https://api.openai.com/v1",'}
                    </span>
                    {'\n'}
                    <span className="text-muted-foreground line-through decoration-muted-foreground/40">
                      {'-    api_key=OPENAI_KEY,'}
                    </span>
                    {'\n'}
                    <span className="font-medium text-primary">
                      {'+    base_url="https://relay.acme.internal/v1",\n'}
                    </span>
                    <span className="font-medium text-primary">
                      {'+    api_key=RELAY_VIRTUAL_KEY,\n'}
                    </span>
                    {' )'}
                  </code>
                </pre>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── SDK ─────────────────────────────────────────────────────────────────────────────── */}
        {/* Placed immediately after the two-line migration, because it answers the question that
            section provokes: "if my SDK still works, what does yours add?" The answer is the
            metadata and the control plane — and saying so here, rather than pitching the package,
            keeps the drop-in claim above intact. */}
        <section id="sdk" className="scroll-mt-24 px-6 py-20">
          <div className="mx-auto grid max-w-5xl items-start gap-10 md:grid-cols-2">
            <div>
              <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Package className="size-5" aria-hidden="true" />
              </span>
              <h2 className="mt-5 text-2xl font-semibold tracking-tight md:text-3xl">
                Or import the library
              </h2>
              <p className="mt-3 text-sm text-muted-foreground md:text-base">
                Your OpenAI client keeps working —{' '}
                <code className="font-mono">relay-gateway-sdk</code> is for when you want what the
                gateway knows about each request as typed fields, and the control plane from code.
                Zero dependencies; Node, Bun, Deno, Workers and browsers.
              </p>
              <ul className="mt-6 space-y-2.5">
                {[
                  'Provider, cost, cache, failover and trace id on every response',
                  'Applications, keys, routes, budgets and plans, fully typed',
                  'Types generated from the gateway’s own OpenAPI document',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <Button asChild variant="outline">
                  <Link href="/docs/sdk">
                    Read the SDK guide <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>

            <Card className="overflow-hidden">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-mono text-xs text-muted-foreground">typescript</span>
              </div>
              <CardContent className="overflow-x-auto p-0">
                <pre className="p-4 font-mono text-xs leading-relaxed">
                  <code>
                    {'const res = await relay.chat.completions.create({\n'}
                    {'  model: '}
                    <span className="text-primary">&quot;fast&quot;</span>
                    {', messages,\n});\n\n'}
                    {'res.relay.provider;  '}
                    <span className="text-muted-foreground">{'// "anthropic"'}</span>
                    {'\n'}
                    {'res.relay.costUsd;   '}
                    <span className="text-muted-foreground">{'// 0.000412'}</span>
                    {'\n'}
                    {'res.relay.failover;  '}
                    <span className="text-muted-foreground">{'// true'}</span>
                    {'\n'}
                    {'res.relay.traceId;   '}
                    <span className="text-muted-foreground">{'// "8f2c…"'}</span>
                  </code>
                </pre>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── Capabilities ────────────────────────────────────────────────────────────────────── */}
        <section id="capabilities" className="scroll-mt-24 px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                What sits between your app and the model
              </h2>
              <p className="mt-3 text-sm text-muted-foreground md:text-base">
                A gateway earns its place by doing the things every team rebuilds badly: routing,
                spend control, key hygiene and a record of what happened.
              </p>
            </div>

            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {CAPABILITIES.map(({ icon: Icon, title, body }) => (
                <Card key={title} className="transition-colors hover:border-primary/40">
                  <CardContent className="p-5">
                    <span className="inline-flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <h3 className="mt-4 text-sm font-medium">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* ── Governance ──────────────────────────────────────────────────────────────────────── */}
        <section id="governance" className="scroll-mt-24 border-y bg-muted/25 px-6 py-20">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldCheck className="size-5" aria-hidden="true" />
              </span>
              <h2 className="mt-5 text-2xl font-semibold tracking-tight md:text-3xl">
                Built for the security review, not around it
              </h2>
              <p className="mt-3 text-sm text-muted-foreground md:text-base">
                Multi-tenancy is where gateways leak. Relay puts the boundary in the database and
                the credential store, so the guarantee does not depend on every future query being
                written carefully.
              </p>
            </div>

            <dl className="grid gap-5 sm:grid-cols-2">
              {GOVERNANCE.map((item) => (
                <div key={item.title} className="rounded-lg border bg-background p-5">
                  <dt className="text-sm font-medium">{item.title}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {item.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Pricing ─────────────────────────────────────────────────────────────────────────
            MVP-FREE: commented out for the trial period — Relay is free for everyone while we are
            in MVP, so advertising tiers we do not charge for would be a lie. The section, the
            component and the catalog API all still work; restore this one line (and the matching
            block in the plan page + the nav item in landing-nav.tsx) to switch selling back on.
            The gateway side is governed by RELAY_EDITION, currently `oss`.

        {isCloud ? <Pricing signedIn={signedIn} /> : null}
        ─────────────────────────────────────────────────────────────────────────────────────── */}

        {/* ── Self-host ───────────────────────────────────────────────────────────────────────── */}
        <section id="self-host" className="scroll-mt-24 px-6 py-20">
          <div className="mx-auto max-w-5xl">
            <FeatureCard>
              <CardContent className="grid gap-10 p-8 md:grid-cols-2 md:p-10">
                <div>
                  <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <GitBranch className="size-5" aria-hidden="true" />
                  </span>
                  <h2 className="mt-5 text-2xl font-semibold tracking-tight md:text-3xl">
                    Runs in your infrastructure
                  </h2>
                  <p className="mt-3 text-sm text-muted-foreground md:text-base">
                    Three containers and a master key. Prompts, completions and provider credentials
                    stay inside your network — there is no Relay-operated service in the path,
                    because there is no Relay-operated service.
                  </p>
                  <ul className="mt-6 space-y-2.5">
                    {[
                      'Signed, multi-arch images from GHCR',
                      'Migrations applied before the gateway serves',
                      'Readiness and liveness endpoints, Prometheus metrics',
                      'Stateless workers — scale horizontally behind a load balancer',
                    ].map((item) => (
                      <li key={item} className="flex items-start gap-2.5 text-sm">
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                        <span className="text-muted-foreground">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="min-w-0">
                  <div className="overflow-hidden rounded-lg border bg-muted/40">
                    <div className="border-b px-4 py-2.5">
                      <span className="font-mono text-xs text-muted-foreground">
                        from zero to a proxied call
                      </span>
                    </div>
                    <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">
                      <code>
                        <span className="text-muted-foreground">$</span> tar -xzf
                        relay-selfhost.tar.gz{'\n'}
                        <span className="text-muted-foreground">$</span> cp .env.example .env{'\n'}
                        <span className="text-muted-foreground">$</span> docker compose up -d
                        {'\n\n'}
                        <span className="text-muted-foreground">
                          {'# readyz → status:ready, warm:true'}
                        </span>
                      </code>
                    </pre>
                  </div>
                  <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                    The one thing to guard: <code className="font-mono">RELAY_MASTER_KEY</code>. It
                    wraps every sealed credential, and losing it makes them unrecoverable.
                  </p>
                </div>
              </CardContent>
            </FeatureCard>
          </div>
        </section>

        {/* ── FAQ ─────────────────────────────────────────────────────────────────────────────── */}
        <section id="faq" className="scroll-mt-24 border-t px-6 py-20">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Questions worth asking first
            </h2>
            <div className="mt-8 divide-y rounded-lg border">
              {FAQ.map((item) => (
                // <details> rather than a JS accordion: keyboard-operable, findable by in-page
                // search, and it works before hydration — which on a landing page matters.
                <details key={item.q} className="group px-5 py-4 [&_summary]:cursor-pointer">
                  <summary className="flex list-none items-center justify-between gap-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {item.q}
                    <span
                      className="text-muted-foreground transition-transform group-open:rotate-45"
                      aria-hidden="true"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ── Closing CTA ─────────────────────────────────────────────────────────────────────── */}
        <section className="border-t bg-muted/25 px-6 py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Put a gateway in front of it before you need one
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground md:text-base">
              The cheapest time to add routing, budgets and an audit trail is before the invoice
              surprises somebody.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {signedIn ? (
                <Button asChild size="lg">
                  <Link href="/dashboard">
                    Open console <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              ) : (
                <form action={signInAction}>
                  <Button type="submit" size="lg">
                    Get started <ArrowRight className="size-4" aria-hidden="true" />
                  </Button>
                </form>
              )}
              <Button asChild variant="outline" size="lg">
                <a href="#capabilities">See what it does</a>
              </Button>
            </div>
            {!logtoConfigured ? (
              <p className="mt-6 text-xs text-muted-foreground">
                Sign-in is unavailable: this deployment has no Logto app configured.
              </p>
            ) : null}
          </div>
        </section>
        {/* ── Closing wordmark ────────────────────────────────────────────────────────────────── */}
        <section className="border-t" aria-labelledby="wordmark-heading">
          <h2 id="wordmark-heading" className="sr-only">
            Relay
          </h2>
          <SparklesWordmark />
        </section>
      </main>

      <footer className="border-t px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <RelayMark className="size-5 text-primary" />
            Relay Gateway
          </span>
          <nav aria-label="Footer" className="flex items-center gap-6 text-sm">
            <a
              href="#capabilities"
              className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Capabilities
            </a>
            <Link
              href="/docs"
              className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Docs
            </Link>
            <a
              href="#self-host"
              className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Self-host
            </a>
            <Link
              href="/dashboard"
              className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Console
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
