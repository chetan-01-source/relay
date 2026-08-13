/**
 * Traffic controller — HTTP boundary for the request feed. The tenant is the caller's own org from
 * the verified JWT. `status` is validated against an allowlisted enum before it reaches the query
 * (no interpolation); `limit` is clamped. The SSE `stream` endpoint hijacks the reply, writes an
 * initial snapshot, then forwards live events until the client disconnects.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay-ai/shared';
import type { TrafficService, UsageStatus } from '../types/traffic.types.js';

const STATUSES: readonly UsageStatus[] = ['ok', 'error', 'rate_limited', 'budget_exceeded'];
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SNAPSHOT_LIMIT = 25;
const HEARTBEAT_MS = 15_000;

interface TrafficQuery {
  limit?: string;
  status?: string;
}

export interface TrafficController {
  listRecent(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  getTrace(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  stream(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createTrafficController(service: TrafficService): TrafficController {
  function orgOf(request: FastifyRequest): string {
    const orgId = request.claims?.orgId;
    if (!orgId) {
      throw new RelayError('invalid_request', {
        message: 'This token is not scoped to an organization.',
      });
    }
    return orgId;
  }

  /** Parse + validate the shared query params. Throws invalid_request on an unknown status. */
  function parseQuery(request: FastifyRequest): { limit: number; status?: UsageStatus } {
    const q = (request.query ?? {}) as TrafficQuery;
    const limit = q.limit
      ? Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    if (q.status && !STATUSES.includes(q.status as UsageStatus)) {
      throw new RelayError('invalid_request', {
        message: `Unknown status '${q.status}'.`,
        param: 'status',
      });
    }
    return { limit, ...(q.status ? { status: q.status as UsageStatus } : {}) };
  }

  return {
    async listRecent(request, reply) {
      const { limit, status } = parseQuery(request);
      const data = await service.listRecent(orgOf(request), {
        limit,
        ...(status ? { status } : {}),
      });
      return reply.send({ object: 'list', data });
    },

    async getTrace(request, reply) {
      const { requestId } = request.params as { requestId: string };
      const data = await service.getTrace(orgOf(request), requestId);
      if (data.length === 0) {
        throw new RelayError('not_found', { message: `No traffic for request '${requestId}'.` });
      }
      return reply.send({ object: 'list', data });
    },

    async stream(request, reply) {
      const orgId = orgOf(request);
      // Take over the socket: SSE is written raw, so Fastify must not try to serialize a body.
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-relay-trace-id': request.headers['x-relay-trace-id'] ?? '',
      });
      reply.raw.write(': connected\n\n');

      // Initial snapshot (oldest→newest) so the table isn't empty before the first live event.
      const recent = await service.listRecent(orgId, { limit: SNAPSHOT_LIMIT });
      for (const event of recent.reverse()) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      const unsubscribe = service.subscribe(orgId, (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      // Comment heartbeat keeps intermediaries from closing an idle connection.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
      });
      return reply;
    },
  };
}
