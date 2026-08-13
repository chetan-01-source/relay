/**
 * The org onboarding state machine — PURE, so the console and its tests agree on the transition
 * without a running gateway. `created` is the seed the gateway assigns on org creation and is not
 * settable; the three that follow are what `POST /platform/orgs/{orgId}/onboarding/advance` accepts
 * in its (required) `state` body. Keeping "what's next" here means the detail page and the server
 * action derive it from one place instead of each guessing.
 */
import type { OnboardingState } from './api';

/** Every state, in order — index 0 is the seed. Drives the progress list on the org detail page. */
export const ONBOARDING_STEPS = [
  'created',
  'admin_invited',
  'provider_added',
  'first_request',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Narrow an untrusted form value to a settable state (everything except the `created` seed). */
export function isOnboardingState(value: string): value is OnboardingState {
  return value !== 'created' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** The step after `current`, or null when onboarding is complete (or `current` is unknown). */
export function nextOnboardingState(current: string): OnboardingState | null {
  const index = (ONBOARDING_STEPS as readonly string[]).indexOf(current);
  if (index < 0) return null;
  const next = ONBOARDING_STEPS[index + 1];
  return next && isOnboardingState(next) ? next : null;
}
