/**
 * Notifications controller — HTTP boundary only. The org comes from the verified token, never the
 * caller, so one tenant can never read or write another's channel, preferences or delivery log.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayError } from '@relay/shared';
import { isNotificationEvent } from '../lib/events.js';
import {
  isChannelType,
  type ChannelType,
  type NotificationsService,
  type SetChannelInput,
} from '../types/notifications.types.js';

/** Union of every channel body; the `type` path parameter decides which fields are read. */
interface ChannelBody {
  from_address?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  webhook_url?: string;
  enabled?: boolean;
}

interface PreferenceBody {
  enabled: boolean;
  recipients?: string[];
}

export interface NotificationsController {
  getChannel(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listChannels(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  setChannel(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  deleteChannel(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  testChannel(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listPreferences(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  setPreference(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  listOutbox(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createNotificationsController(
  service: NotificationsService,
): NotificationsController {
  function orgOf(request: FastifyRequest): string {
    const orgId = request.claims?.orgId;
    if (!orgId) {
      throw new RelayError('invalid_request', {
        message: 'This token is not scoped to an organization.',
      });
    }
    return orgId;
  }
  function actorOf(request: FastifyRequest): string {
    return request.claims?.userId ?? 'system';
  }
  /** The channel kind from the path. Route schemas already enum-check it; this narrows the type. */
  function typeOf(request: FastifyRequest): ChannelType {
    const { type } = request.params as { type: string };
    if (!isChannelType(type)) {
      throw new RelayError('not_found', { message: `Unknown channel type '${type}'.` });
    }
    return type;
  }

  return {
    async getChannel(request, reply) {
      const channel = await service.getChannel(orgOf(request), typeOf(request));
      // 200 with null rather than 404: "no channel configured" is a normal state the console needs
      // to render a form for, not a missing resource.
      return reply.send({ object: 'notification.channel', data: channel });
    },

    async listChannels(request, reply) {
      return reply.send({ object: 'list', data: await service.listChannels(orgOf(request)) });
    },

    async setChannel(request, reply) {
      const body = request.body as ChannelBody;
      const type = typeOf(request);
      const input: SetChannelInput =
        type === 'email_smtp'
          ? {
              type,
              fromAddress: body.from_address ?? '',
              host: body.host ?? '',
              port: body.port ?? 0,
              secure: body.secure ?? true,
              enabled: body.enabled ?? true,
              ...(body.user ? { user: body.user } : {}),
              ...(body.password ? { password: body.password } : {}),
            }
          : {
              type,
              enabled: body.enabled ?? true,
              ...(body.webhook_url ? { webhookUrl: body.webhook_url } : {}),
            };
      return reply.send(await service.setChannel(actorOf(request), orgOf(request), input));
    },

    async deleteChannel(request, reply) {
      await service.deleteChannel(actorOf(request), orgOf(request), typeOf(request));
      return reply.code(204).send();
    },

    async testChannel(request, reply) {
      return reply.send(
        await service.testChannel(actorOf(request), orgOf(request), typeOf(request)),
      );
    },

    async listPreferences(request, reply) {
      return reply.send({ object: 'list', data: await service.listPreferences(orgOf(request)) });
    },

    async setPreference(request, reply) {
      const { event } = request.params as { event: string };
      if (!isNotificationEvent(event)) {
        throw new RelayError('not_found', { message: `Unknown notification event '${event}'.` });
      }
      const body = request.body as PreferenceBody;
      return reply.send(
        await service.setPreference(
          actorOf(request),
          orgOf(request),
          event,
          body.enabled,
          body.recipients ?? [],
        ),
      );
    },

    async listOutbox(request, reply) {
      const { limit } = request.query as { limit?: number };
      return reply.send({
        object: 'list',
        data: await service.listOutbox(orgOf(request), limit ?? 50),
      });
    },
  };
}
