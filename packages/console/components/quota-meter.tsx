/**
 * One quota row: what it is, how much is used, and how close the ceiling is.
 *
 * A server component — no state, no client JS. The bar is the same idiom as the budget meter
 * (`budget-scope.tsx`) on purpose: an operator should not have to learn two ways of reading "how
 * full is this", and the amber threshold is the same 80% the gateway warns at.
 *
 * Colour is never the only signal (UI-THEME §4): the numeric "9 / 10" and the status sentence carry
 * the same information, so the row is readable in greyscale and to a screen reader.
 */
import { TriangleAlert } from 'lucide-react';
import { formatCount, isNearFull, sourceLabel, type QuotaRow } from '../app/lib/plan';

export function QuotaMeter({ row }: { row: QuotaRow }) {
  const percent = row.ratio === null ? 0 : Math.round(row.ratio * 100);
  const tone = row.over || row.exhausted ? 'full' : isNearFull(row.ratio) ? 'near' : 'ok';

  return (
    <div className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">{row.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{row.hint}</p>
        </div>
        <p className="shrink-0 font-mono text-sm tabular-nums">
          {formatCount(row.used)}
          <span className="text-muted-foreground">
            {' / '}
            {row.limit === null ? '∞' : formatCount(row.limit)}
          </span>
        </p>
      </div>

      {/* An unlimited quota gets no track at all. A full-width bar under "∞" would read as
          "you are at your limit", which is the opposite of what it means. */}
      {row.limit === null ? (
        <p className="text-xs text-muted-foreground">Unlimited · {sourceLabel(row.source)}</p>
      ) : (
        <>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${row.label} used`}
          >
            <div
              className={`h-full transition-colors ${
                tone === 'full' ? 'bg-destructive' : tone === 'near' ? 'bg-amber-500' : 'bg-primary'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p
            className={`flex items-center gap-1.5 text-xs ${
              tone === 'full' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {tone === 'full' ? (
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            ) : null}
            {row.over
              ? `Over the limit — you keep everything you have, but cannot create another.`
              : row.exhausted
                ? `At the limit — creating another is refused with quota_exceeded.`
                : `${percent}% used · ${sourceLabel(row.source)}`}
          </p>
        </>
      )}
    </div>
  );
}
