/** Structured logging (pino). Every line carries org_id/trace_id via the ALS context. */
import { pino, type Logger } from 'pino';
import { getContext } from './als.js';

export function createLogger(level: string): Logger {
  return pino({
    level,
    // pull tenant/trace ids onto every line without threading them through call sites
    mixin() {
      const ctx = getContext();
      return ctx ? { org_id: ctx.orgId, trace_id: ctx.traceId } : {};
    },
    redact: {
      paths: ['req.headers.authorization', 'authorization', '*.apiKey', '*.secret'],
      censor: '***',
    },
  });
}

export type { Logger };
