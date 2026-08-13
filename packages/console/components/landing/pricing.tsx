/**
 * The landing page's pricing section — CLOUD EDITION ONLY.
 *
 * DESIGN NOTES (docs/UI-THEME.md · design engine pattern "Pricing-Focused Landing"):
 *  • Kept from the pattern: three-to-four tier cards, one CTA per card, a recommended tier
 *    emphasised, and the objections answered in the FAQ below rather than in the cards.
 *  • Dropped: the pattern's second CTA colour (§4 allows exactly one accent), its per-tier colour
 *    coding (grey/blue/gold/dark — four accents), and the "most popular" badge. We have no
 *    popularity data, and inventing it is the same failure as the fabricated customer logos the rest
 *    of this page refuses. The recommended tier is marked "Recommended" — a claim we are making,
 *    which is honest — rather than "Most popular", a measurement we do not have.
 *  • Prices come from the gateway's public catalog, not from a constant here, so a price change is a
 *    row edit and the marketing page can never disagree with what the console charges.
 *
 * Renders nothing when the catalog is empty, which is exactly what a self-hosted deployment returns.
 */
import { Check, Minus } from 'lucide-react';
import { signInAction } from '../../app/actions';
import { listPlans, type PlanCatalogEntry } from '../../app/lib/api';
import { LIMIT_LABEL, formatLimit, formatPrice } from '../../app/lib/plan';
import { Button } from '../ui/button';

/** The tier we point an evaluating team at. A claim, and one we are willing to put in writing. */
const RECOMMENDED = 'pro';

/** The four numbers that actually decide a tier, and the capabilities people ask about by name. */
const HEADLINE_LIMITS = ['apps.max', 'members.max', 'rate.rpm', 'spend.monthly_usd.max'] as const;
const HEADLINE_FEATURES = ['cache.exact', 'routing.failover', 'modalities.image'] as const;

export async function Pricing({ signedIn }: { signedIn: boolean }) {
  const plans = await listPlans();
  if (plans.length === 0) return null;

  return (
    <section id="pricing" className="scroll-mt-24 border-y bg-muted/25 px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Priced on what you actually run
          </h2>
          <p className="mt-3 text-sm text-muted-foreground md:text-base">
            Tiers are sized by applications, seats and throughput — not by a request count that
            punishes a bursty week. Every plan enforces its limits in the gateway itself, and the
            console shows you where each number came from.
          </p>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => (
            <PlanCard key={(plan as { code?: string }).code} plan={plan} signedIn={signedIn} />
          ))}
        </div>

        <p className="mt-8 max-w-2xl text-sm text-muted-foreground">
          Prefer to run it yourself? Relay is Apache-2.0 and the self-hosted build has{' '}
          <strong className="font-medium text-foreground">no limits at all</strong> — every
          capability on, every ceiling unlimited. What the hosted plans sell is operation, not
          features held back.
        </p>
      </div>
    </section>
  );
}

function PlanCard({ plan, signedIn }: { plan: PlanCatalogEntry; signedIn: boolean }) {
  const code = (plan as { code?: string }).code ?? '';
  const name = (plan as { name?: string }).name ?? code;
  const description = (plan as { description?: string }).description ?? '';
  const price = formatPrice((plan as { price_monthly_usd?: number | null }).price_monthly_usd);
  const limits = (plan as { limits?: Record<string, number | boolean | null> }).limits ?? {};
  const recommended = code === RECOMMENDED;

  return (
    <div
      className={`flex flex-col rounded-lg border bg-background p-6 transition-colors ${
        recommended ? 'border-primary/60 shadow-sm' : 'hover:border-primary/40'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{name}</h3>
        {recommended ? (
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            Recommended
          </span>
        ) : null}
      </div>

      <p className="mt-3 font-mono text-3xl font-semibold tabular-nums">
        {price ?? 'Talk to us'}
        {price && price !== 'Free' ? (
          <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">/month</span>
        ) : null}
      </p>
      <p className="mt-2 min-h-[3rem] text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>

      <dl className="mt-6 space-y-2 border-t pt-5 text-sm">
        {HEADLINE_LIMITS.map((key) => (
          <div key={key} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{LIMIT_LABEL[key]}</dt>
            <dd className="shrink-0 font-mono text-xs tabular-nums">
              {formatLimit(key, limits[key])}
            </dd>
          </div>
        ))}
      </dl>

      <ul className="mt-5 space-y-2 border-t pt-5 text-sm">
        {HEADLINE_FEATURES.map((key) => {
          const included = limits[key] !== false;
          return (
            <li key={key} className="flex items-start gap-2">
              {included ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              ) : (
                <Minus
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              {/* The muted text carries "not included" as words, so the row is legible without
                  relying on the icon's colour (UI-THEME §4). */}
              <span className={included ? 'text-muted-foreground' : 'text-muted-foreground/70'}>
                {LIMIT_LABEL[key]}
                {included ? '' : ' — not included'}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 pt-1">
        {price === null ? (
          <Button asChild variant="outline" className="w-full">
            <a href="mailto:sales@relay.gateway">Talk to us</a>
          </Button>
        ) : signedIn ? (
          // Already signed in: the plan page knows their org and can actually make the change.
          <Button asChild variant={recommended ? 'default' : 'outline'} className="w-full">
            <a href="/plan">Switch to {name}</a>
          </Button>
        ) : (
          // A real form post to the sign-in server action — works with JavaScript disabled, and needs
          // no throwaway `?signin=1` route.
          <form action={signInAction}>
            <Button type="submit" variant={recommended ? 'default' : 'outline'} className="w-full">
              {price === 'Free' ? 'Start free' : `Choose ${name}`}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
