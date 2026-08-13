/**
 * Plan & usage — what this organization is entitled to, and how much of it is spent.
 *
 * Two audiences, one screen. An operator asks "am I about to run out of something"; a buyer asks
 * "what would the next tier give me". The page answers the first question at the top (meters, in the
 * order things get consumed) and the second at the bottom (the catalog), rather than leading with a
 * price list an existing customer has to scroll past every time.
 *
 * DESIGN NOTES (docs/UI-THEME.md):
 *  • Structure is the design engine's "Pricing-Focused Landing" pattern, reordered for a console:
 *    current state → quotas → capabilities → catalog. Its palette and typography recommendations
 *    (a second orange CTA colour, JetBrains Mono headings) are DROPPED — §4 allows exactly one
 *    accent and the console is already on Geist. A pricing page inside an admin tool should look
 *    like the admin tool.
 *  • No "most popular" badge. That is a conversion device for anonymous traffic; to a signed-in
 *    customer reading their own limits it is noise, and inventing popularity we cannot measure is
 *    the same failure as the fabricated logos the landing page refuses.
 *  • Server-rendered. The only client component is the change-plan form, which needs pending state.
 *
 * In the self-hosted edition every ceiling is `null`, so this renders real usage counts with
 * "Unlimited" beside each — genuinely useful capacity information — and no catalog to buy from.
 */
import Link from 'next/link';
// MVP-FREE: ArrowRight / isOrgAdmin / listPlans / PlanCatalogEntry are used only by the commented
// catalog block at the foot of this file. Restore these imports with it.
// import { ArrowRight } from 'lucide-react';
// import { isOrgAdmin } from '../../lib/auth';
// import { listPlans, type PlanCatalogEntry } from '../../lib/api';
import { Check, Gauge, Minus, TriangleAlert } from 'lucide-react';
import { requireOrg } from '../../lib/auth';
import { getPlan, type EffectivePlan } from '../../lib/api';
import { isCloud } from '../../lib/edition';
import {
  FEATURE_KEYS,
  LIMIT_HINT,
  LIMIT_LABEL,
  RETENTION_KEYS,
  THROUGHPUT_KEYS,
  formatLimit,
  // MVP-FREE: formatPrice is only used by the commented catalog card.
  // formatPrice,
  isEnabled,
  limitOf,
  quotaRows,
  sourceLabel,
  sourceOf,
  statusNote,
  type PlanLimitKey,
} from '../../lib/plan';
import { QuotaMeter } from '../../../components/quota-meter';
// MVP-FREE: the upgrade form and its Button, used only by the commented catalog card.
// import { ChangePlanForm } from '../../../components/change-plan-form';
// import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { FeatureCard } from '../../../components/ui/feature-card';

export const dynamic = 'force-dynamic';

export default async function PlanPage() {
  // Still gates the page on a resolvable org identity, even though `me` itself is only read by the
  // commented catalog block (MVP-FREE).
  await requireOrg();
  // MVP-FREE: the catalog and the upgrade controls are commented out below, so neither of these is
  // read right now. Restore both lines with that block.
  // const canChange = isOrgAdmin(me) && isCloud;
  // const [plan, catalog] = await Promise.all([
  //   getPlan(),
  //   isCloud ? listPlans() : Promise.resolve([]),
  // ]);
  const plan = await getPlan();

  const rows = quotaRows(plan);
  const note = statusNote(plan);
  const current = (plan as { plan?: { code?: string; name?: string; tier?: number } }).plan ?? {};
  // MVP-FREE: only the catalog compares tiers. Restore with that block.
  // const currentTier = current.tier ?? 0;
  const periodEnd = (plan as { current_period_end?: string | null }).current_period_end ?? null;
  const anyExhausted = rows.some((row) => row.exhausted);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plan &amp; usage</h1>
        <p className="text-sm text-muted-foreground">
          What this organization is entitled to, where each limit comes from, and how much is used.
        </p>
      </div>

      {/* ── Current plan ─────────────────────────────────────────────────────────────────────── */}
      <FeatureCard>
        <CardContent className="flex flex-wrap items-start justify-between gap-6 p-6">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Current plan
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">{current.name ?? 'Free'}</h2>
              <Badge variant={note?.tone === 'warning' ? 'secondary' : 'success'}>
                {(plan as { status?: string }).status ?? 'active'}
              </Badge>
            </div>
            {note ? (
              <p
                className={`mt-3 flex max-w-prose items-start gap-2 text-sm ${
                  note.tone === 'warning' ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {note.tone === 'warning' ? (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                ) : null}
                {note.message}
              </p>
            ) : (
              <p className="mt-3 max-w-prose text-sm text-muted-foreground">
                {isCloud
                  ? 'Limits below are enforced by the gateway itself, not only by this console.'
                  : 'Self-hosted: every limit is unlimited and every capability is included. The counts below are capacity information, not ceilings.'}
              </p>
            )}
            {periodEnd ? (
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                Renews {new Date(periodEnd).toISOString().slice(0, 10)}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-start gap-2">
            <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Gauge className="size-5" aria-hidden="true" />
            </span>
            {anyExhausted ? (
              <p className="max-w-[16rem] text-xs leading-relaxed text-muted-foreground">
                At least one quota is full. Creating another is refused with{' '}
                <code className="font-mono">quota_exceeded</code>.
              </p>
            ) : null}
          </div>
        </CardContent>
      </FeatureCard>

      {/* ── Quotas ───────────────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Quotas</CardTitle>
          <CardDescription>
            Checked when you create something, inside the same transaction as the write — so two
            simultaneous creates cannot both slip past a ceiling.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {rows.map((row) => (
            <QuotaMeter key={row.key} row={row} />
          ))}
        </CardContent>
      </Card>

      {/* ── Throughput + retention ───────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Throughput &amp; retention</CardTitle>
          <CardDescription>
            Enforced on every request. Where you have also set your own rate limit or budget, the
            tighter of the two applies — lowering yours always works, raising it past the plan does
            not.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {[...THROUGHPUT_KEYS, ...RETENTION_KEYS].map((key) => (
            <ValueRow key={key} plan={plan} limitKey={key} />
          ))}
        </CardContent>
      </Card>

      {/* ── Capabilities ─────────────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Capabilities</CardTitle>
          <CardDescription>
            Each of these has exactly one enforcement point in the gateway. Anything excluded is
            refused with <code className="font-mono">plan_upgrade_required</code>, not silently
            ignored.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {FEATURE_KEYS.map((key) => {
            const on = isEnabled(plan, key);
            return (
              <div key={key} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
                <span
                  className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full ${
                    on ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {on ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Minus className="size-3.5" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {LIMIT_LABEL[key]}{' '}
                    {/* The word carries the state, not just the icon colour (UI-THEME §4). */}
                    <span className="text-muted-foreground">
                      · {on ? 'included' : 'not included'}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {LIMIT_HINT[key]} · {sourceLabel(sourceOf(limitOf(plan, key)))}
                  </p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Catalog ──────────────────────────────────────────────────────────────────────────
          MVP-FREE: commented out for the trial period. Every organization is on unlimited limits
          while we are in MVP, so there is nothing to upgrade to and a catalog would only offer a
          purchase we do not take. The quota meters above stay — they are useful capacity
          information either way. Restore this block, the landing pricing section and the nav item
          together, and set RELAY_EDITION=cloud, to switch selling back on.

      {isCloud && catalog.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Available plans</CardTitle>
            <CardDescription>
              Changes take effect on the data plane within about a second. Nothing is deleted when
              you move down — you simply cannot create more until you are under the new limits.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {catalog.map((entry) => (
              <PlanCard
                key={entry.code}
                entry={entry}
                currentCode={current.code ?? ''}
                currentTier={currentTier}
                canChange={canChange}
                isAdmin={isOrgAdmin(me)}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}
      ──────────────────────────────────────────────────────────────────────────────────────── */}

      <p className="text-xs text-muted-foreground">
        Full reference — every limit, where it is enforced and what it returns —{' '}
        <Link href="/docs/plans" className="text-primary underline underline-offset-4">
          in the docs
        </Link>
        .
      </p>
    </div>
  );
}

/** A ceiling with no "used" count: a value, where it came from, and what it means. */
function ValueRow({ plan, limitKey }: { plan: EffectivePlan; limitKey: PlanLimitKey }) {
  const limit = limitOf(plan, limitKey);
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{LIMIT_LABEL[limitKey]}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {LIMIT_HINT[limitKey]}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-sm tabular-nums">{formatLimit(limitKey, limit.value)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{sourceLabel(sourceOf(limit))}</p>
      </div>
    </div>
  );
}

/* MVP-FREE: the catalog card. Unreferenced while the catalog block above is commented out;
   kept verbatim so restoring selling is uncommenting, not rewriting.

function PlanCard({
  entry,
  currentCode,
  currentTier,
  canChange,
  isAdmin,
}: {
  entry: PlanCatalogEntry;
  currentCode: string;
  currentTier: number;
  canChange: boolean;
  isAdmin: boolean;
}) {
  const code = (entry as { code?: string }).code ?? '';
  const name = (entry as { name?: string }).name ?? code;
  const tier = (entry as { tier?: number }).tier ?? 0;
  const price = formatPrice((entry as { price_monthly_usd?: number | null }).price_monthly_usd);
  const limits = (entry as { limits?: Record<string, number | boolean | null> }).limits ?? {};
  const isCurrent = code === currentCode;
  const isDowngrade = tier < currentTier;

  return (
    <div
      className={`flex flex-col rounded-lg border p-5 transition-colors ${
        isCurrent ? 'border-primary/50 bg-primary/[0.03]' : 'hover:border-primary/40'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{name}</h3>
        {isCurrent ? <Badge variant="outline">Current</Badge> : null}
      </div>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
        {price ?? 'Contact us'}
        {price && price !== 'Free' ? (
          <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">/month</span>
        ) : null}
      </p>
      <p className="mt-1 min-h-[2.5rem] text-xs leading-relaxed text-muted-foreground">
        {(entry as { description?: string }).description ?? ''}
      </p>

      <dl className="mt-4 flex-1 space-y-1.5 text-xs">
        {(['apps.max', 'members.max', 'rate.rpm', 'spend.monthly_usd.max'] as const).map((key) => (
          <div key={key} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{LIMIT_LABEL[key]}</dt>
            <dd className="font-mono tabular-nums">{formatLimit(key, limits[key])}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5">
        {isCurrent ? (
          <Button variant="outline" className="w-full" disabled>
            Current plan
          </Button>
        ) : price === null ? (
          // A plan quoted on request has no self-serve path — sending someone to a button that
          // cannot work is worse than sending them to a person.
          <Button asChild variant="outline" className="w-full">
            <a href="mailto:sales@relay.gateway">
              Talk to us <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </Button>
        ) : canChange ? (
          <ChangePlanForm
            planCode={code}
            planName={name}
            isDowngrade={isDowngrade}
            label={isDowngrade ? `Move to ${name}` : `Upgrade to ${name}`}
          />
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            {isAdmin ? 'Not available here' : 'An organization administrator can change the plan.'}
          </p>
        )}
      </div>
    </div>
  );
}
*/
