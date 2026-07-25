/**
 * Setup checklist (Day 13) — PURE. Derives the org onboarding progress from the data the org user can
 * actually read (apps, providers, usage), rather than the platform-admin onboarding state machine
 * (which an org member cannot query). Each step is "done" when its precondition is observably true, so
 * the checklist self-completes as the user builds — no separate state to keep in sync.
 */
export interface ChecklistInputs {
  appCount: number;
  keyCount: number;
  providerCount: number;
  requestCount: number;
}

export interface ChecklistStep {
  id: 'app' | 'provider' | 'key' | 'request';
  label: string;
  done: boolean;
}

export function buildChecklist(inputs: ChecklistInputs): ChecklistStep[] {
  return [
    { id: 'app', label: 'Create an application', done: inputs.appCount > 0 },
    { id: 'provider', label: 'Add a provider credential', done: inputs.providerCount > 0 },
    { id: 'key', label: 'Issue a virtual key', done: inputs.keyCount > 0 },
    { id: 'request', label: 'Make your first request', done: inputs.requestCount > 0 },
  ];
}

/** Fraction of steps complete, 0..1 — drives the progress label. */
export function checklistProgress(steps: ChecklistStep[]): number {
  if (steps.length === 0) return 0;
  return steps.filter((s) => s.done).length / steps.length;
}
