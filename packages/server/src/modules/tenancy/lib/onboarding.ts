/**
 * Onboarding state machine (Week 2 Day 7). Pure transition rules — no IO. The lifecycle is strictly
 * linear and advances one step at a time; the service enforces these rules and records each hop as
 * an audit event, while migration 0011's CHECK guards the column at the database.
 *
 *   created → admin_invited → provider_added → first_request
 */
import type { OnboardingState } from '../types/tenancy.types.js';

/** The states in order. Index position defines "forward". */
export const ONBOARDING_ORDER: readonly OnboardingState[] = [
  'created',
  'admin_invited',
  'provider_added',
  'first_request',
];

/** True only for a move to the immediately-following state — no skips, no going back, no self-loops. */
export function canAdvance(from: OnboardingState, to: OnboardingState): boolean {
  return ONBOARDING_ORDER.indexOf(to) === ONBOARDING_ORDER.indexOf(from) + 1;
}

/** The next state after `from`, or null if already at the end. Handy for callers that just advance. */
export function nextState(from: OnboardingState): OnboardingState | null {
  return ONBOARDING_ORDER[ONBOARDING_ORDER.indexOf(from) + 1] ?? null;
}
