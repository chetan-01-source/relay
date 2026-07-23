/**
 * Analytics controller (DEVELOPMENT.md §2) — HTTP boundary only. Validates the query params (via the
 * pure usage-format lib), resolves the caller's org from the verified JWT (never the client body),
 * calls the service, and shapes the JSON envelope or the CSV export. No business logic, no SQL.
 * Errors are thrown as RelayError and formatted centrally by the app's errorHandler.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import { parseFormat, parseGroupBy, parseWindow, toCsv } from '../lib/usage-format.js';
import type { AnalyticsService, UsageSummary } from '../types/analytics.types.js';

interface UsageQuery {
  group_by?: string;
  format?: string;
  from?: string;
  to?: string;
}

export interface AnalyticsController {
  getUsage(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getUsageAllOrgs(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createAnalyticsController(service: AnalyticsService): AnalyticsController {
  /** The caller's org, from the verified token. Fails loud if the token carries no org context. */
  function orgOf(request: FastifyRequest): string {
    const orgId = request.claims?.orgId;
    if (!orgId) {
      throw new RelayError('invalid_request', {
        message: 'This token is not scoped to an organization.',
      });
    }
    return orgId;
  }

  return {
    async getUsage(request, reply) {
      const query = (request.query ?? {}) as UsageQuery;
      const format = parseFormat(query.format);
      const summary = await service.getUsage(orgOf(request), {
        groupBy: parseGroupBy(query.group_by),
        ...parseWindow(query),
      });
      return send(reply, summary, format, 'usage');
    },

    async getUsageAllOrgs(request, reply) {
      const query = (request.query ?? {}) as UsageQuery;
      const format = parseFormat(query.format);
      const summary = await service.getUsageAllOrgs(parseWindow(query));
      return send(reply, summary, format, 'usage-by-org');
    },
  };
}

function send(
  reply: FastifyReply,
  summary: UsageSummary,
  format: 'json' | 'csv',
  filename: string,
): FastifyReply {
  if (format === 'csv') {
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}.csv"`);
    return reply.send(toCsv(summary.data));
  }
  return reply.send(summary);
}
