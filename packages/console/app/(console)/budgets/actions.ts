'use server';

/**
 * Server actions for the budgets screen. These run on the server, so the caller's Logto token is
 * attached by the typed client and never reaches the browser. The gateway enforces `budgets:write`
 * — the UI is a convenience, not the authority.
 */
import { revalidatePath } from 'next/cache';
import { limitScaleError } from '../../lib/budget';
import { setBudget, deleteBudget, type BudgetPeriod } from '../../lib/api';
import { BUDGET_PERIODS } from '../../lib/budget';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

/** Narrow an untrusted form value to a period the API accepts. */
function parsePeriod(value: string): BudgetPeriod | null {
  return (BUDGET_PERIODS as readonly string[]).includes(value) ? (value as BudgetPeriod) : null;
}

/** An empty app_id field means the org-wide ceiling; a value scopes it to that application. */
function appIdOf(formData: FormData): string | null {
  return field(formData, 'app_id') || null;
}

/** Create or change a ceiling, org-wide or for one application. */
export async function setBudgetAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const period = parsePeriod(field(formData, 'period'));
  if (!period) return { ok: false, error: 'Unknown budget period.' };

  const raw = field(formData, 'limit_usd');
  const limitUsd = Number(raw);
  // Checked here so the common mistake gets an instant, specific message instead of a round trip;
  // the gateway validates independently and remains the authority.
  if (!raw || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    return { ok: false, error: 'Enter a limit greater than 0.' };
  }
  // Mirrors the gateway's storage scale (numeric(12,4)). Without it, a limit below 0.0001 is stored
  // as 0 — and a zero hard-cutoff budget blocks every request the organization makes.
  const message = limitScaleError(limitUsd);
  if (message) return { ok: false, error: message };

  try {
    await setBudget(appIdOf(formData), period, {
      limit_usd: limitUsd,
      hard_cutoff: formData.get('hard_cutoff') === 'on',
    });
    revalidatePath('/budgets');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

/** Remove a ceiling — the data plane stops enforcing that one; others still apply. */
export async function deleteBudgetAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const period = parsePeriod(field(formData, 'period'));
  if (!period) return { ok: false, error: 'Unknown budget period.' };
  try {
    await deleteBudget(appIdOf(formData), period);
    revalidatePath('/budgets');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}
