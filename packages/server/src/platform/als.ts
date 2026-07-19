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

/**
 * Bind the context to the CURRENT async execution — used from a Fastify preHandler, whose work
 * (and every handler after it) shares this async context. Unlike runWithContext it takes no
 * callback: the store simply persists for the rest of the request, so logs/withTenant/metrics
 * downstream all see the tenant + trace ids without threading them by hand.
 */
export function enterContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}
