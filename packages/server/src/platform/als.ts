/**
 * AsyncLocalStorage request context (PRD §4 Day 3). Carries tenant + trace identity
 * through the async call graph so logs, DB tenancy, and metrics never pass it by hand.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  orgId: string | null;
  traceId: string;
  isPlatformAdmin: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}
