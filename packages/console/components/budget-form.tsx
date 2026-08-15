'use client';

/**
 * Set / change / remove the ceiling for one period.
 *
 * The same form does create and update, because the API does: the period is the resource's key, so a
 * write is an idempotent PUT. Pre-filling with the current values means "change it" is editing a
 * number rather than re-entering the whole thing.
 */
import { useActionState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  setBudgetAction,
  deleteBudgetAction,
  type ActionResult,
} from '../app/(console)/budgets/actions';
import { enforcementSummary } from '../app/lib/budget';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const INITIAL: ActionResult = { ok: false };

export interface BudgetFormProps {
  period: string;
  /** Current ceiling, or null when none is set yet. */
  limitUsd: number | null;
  hardCutoff: boolean;
  /** Application this ceiling binds, or null for the org-wide one. */
  appId?: string | null;
}

export function BudgetForm({ period, limitUsd, hardCutoff, appId = null }: BudgetFormProps) {
  const [state, action, pending] = useActionState(setBudgetAction, INITIAL);
  const [removeState, removeAction, removing] = useActionState(deleteBudgetAction, INITIAL);
  const exists = limitUsd !== null;

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="period" value={period} />
        <input type="hidden" name="app_id" value={appId ?? ''} />
        <div className="space-y-1.5">
          <Label htmlFor={`limit-${appId ?? 'org'}-${period}`}>Limit (USD)</Label>
          <Input
            id={`limit-${appId ?? 'org'}-${period}`}
            name="limit_usd"
            type="number"
            min="0.0001"
            // `step` is measured FROM `min`, not from zero. With step="0.01" the only valid values
            // were 0.0001, 0.0101, 0.0201 … so an ordinary "50" failed the browser's step check and
            // the form silently refused to submit. 0.0001 is the column's scale (numeric(12,4)) and
            // the smallest ceiling the gateway accepts, so every value it allows is reachable here.
            step="0.0001"
            inputMode="decimal"
            defaultValue={limitUsd ?? ''}
            placeholder="50.00"
            className="w-40"
            required
          />
        </div>

        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            name="hard_cutoff"
            defaultChecked={hardCutoff}
            className="size-4 accent-primary"
          />
          Block requests at the limit
        </label>

        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : exists ? 'Update budget' : 'Set budget'}
        </Button>

        {exists ? null : (
          <p className="pb-2 text-xs text-muted-foreground">No {period} ceiling is enforced.</p>
        )}
      </form>

      <p className="text-xs text-muted-foreground">{enforcementSummary(hardCutoff)}</p>

      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}

      {exists ? (
        <form action={removeAction}>
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="app_id" value={appId ?? ''} />
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            <Trash2 aria-hidden="true" /> {removing ? 'Removing…' : 'Remove budget'}
          </Button>
          {removeState.error ? (
            <p className="mt-1 text-sm text-destructive" role="alert">
              {removeState.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
