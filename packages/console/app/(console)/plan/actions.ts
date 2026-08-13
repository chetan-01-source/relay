'use server';

/**
 * Server actions for the plan screen. These run on the server, so the caller's Logto token is
 * attached by the typed client and never reaches the browser. The gateway enforces `budgets:write`
 * plus organization-administrator — the UI is a convenience, not the authority.
 */
import { revalidatePath } from 'next/cache';
import { changePlan } from '../../lib/api';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Move the organization to another public plan.
 *
 * The plan code is NOT validated here beyond being present: the gateway rejects anything that is not
 * public and active (a tenant must not be able to name `self_hosted` and grant itself everything),
 * and duplicating that rule in the browser layer would give it two places to drift.
 */
export async function changePlanAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const planCode = formData.get('plan_code');
  if (typeof planCode !== 'string' || !planCode) {
    return { ok: false, error: 'Choose a plan first.' };
  }
  try {
    await changePlan(planCode);
    // The data plane picks the new ceilings up within ~1s via snapshot invalidation; this only
    // refreshes what the operator is looking at.
    revalidatePath('/plan');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Request failed' };
  }
}
