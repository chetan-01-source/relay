/**
 * Notification routes — org-scoped. Each `schema` block does triple duty: request validation,
 * Swagger UI, and the generated OpenAPI spec. Guarded by the identity preHandlers: authJwt (401)
 * then requireScope (403).
 *
 * Note what the channel schema does NOT declare: the SMTP password. Fastify serializes responses
 * through these schemas, so leaving it out is a second, structural guarantee that the secret cannot
 * escape even if a handler were changed to return it.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthPreHandler } from '../../identity/index.js';
import { NOTIFICATION_EVENTS } from '../lib/events.js';
import { CHANNEL_TYPES } from '../types/notifications.types.js';
import type { NotificationsController } from '../controllers/notifications.controller.js';

const errorObject = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        type: { type: 'string' },
        code: { type: 'string' },
        param: { type: ['string', 'null'] },
      },
    },
  },
};

export const channelObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    type: { type: 'string', enum: CHANNEL_TYPES },
    from_address: { type: ['string', 'null'] },
    host: { type: ['string', 'null'] },
    port: { type: ['integer', 'null'] },
    secure: { type: 'boolean' },
    user: { type: ['string', 'null'] },
    // Deliberately not the webhook URL: possession of it is authority to post into the channel.
    target: { type: ['string', 'null'] },
    has_secret: { type: 'boolean' },
    enabled: { type: 'boolean' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
};

const channelTestObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    type: { type: 'string', enum: CHANNEL_TYPES },
    ok: { type: 'boolean' },
    detail: { type: 'string' },
  },
};

const channelParams = {
  type: 'object',
  required: ['type'],
  properties: { type: { type: 'string', enum: CHANNEL_TYPES } },
};

const preferenceObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    event_type: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
    enabled: { type: 'boolean' },
    recipients: { type: 'array', items: { type: 'string' } },
  },
};

const outboxObject = {
  type: 'object',
  properties: {
    object: { type: 'string' },
    id: { type: 'string' },
    event_type: { type: 'string' },
    status: { type: 'string' },
    attempts: { type: 'integer' },
    recipients: { type: 'array', items: { type: 'string' } },
    delivered_to: { type: 'array', items: { type: 'string' } },
    last_error: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    sent_at: { type: ['string', 'null'] },
  },
};

export interface NotificationsRouteGuards {
  authJwt: AuthPreHandler;
  requireScope: (...scopes: string[]) => AuthPreHandler;
  requireOrgAdmin: () => AuthPreHandler;
}

export function registerNotificationsRoutes(
  app: FastifyInstance,
  controller: NotificationsController,
  guards: NotificationsRouteGuards,
): void {
  const tags = ['notifications'];
  const read = [guards.authJwt, guards.requireScope('notifications:read')];
  const write = [guards.authJwt, guards.requireScope('notifications:write')];
  // Channels hold credentials — an SMTP password, or a webhook URL that is authority to post into a
  // company chat room. Same class of secret as a provider key, so the same gate: org administrators
  // only. Preferences (who hears about what) stay open to any member with the write scope.
  const channelWrite = [
    guards.authJwt,
    guards.requireScope('notifications:write'),
    guards.requireOrgAdmin(),
  ];

  app.get(
    '/api/v1/notifications/channels',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List every delivery channel this organization has configured',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: channelObject },
            },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.listChannels(request, reply),
  );

  app.get(
    '/api/v1/notifications/channels/:type',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Read one delivery channel (never returns the secret)',
        params: channelParams,
        response: {
          200: {
            type: 'object',
            properties: { object: { type: 'string' }, data: { ...channelObject, nullable: true } },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.getChannel(request, reply),
  );

  app.put(
    '/api/v1/notifications/channels/:type',
    {
      preHandler: channelWrite,
      schema: {
        tags,
        summary:
          'Configure a delivery channel. SMTP takes host/port/from_address; Slack and Teams take webhook_url. Omit the secret to keep the stored one.',
        params: channelParams,
        body: {
          type: 'object',
          properties: {
            from_address: { type: 'string' },
            host: { type: 'string', minLength: 1 },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            secure: { type: 'boolean' },
            user: { type: 'string' },
            password: { type: 'string' },
            webhook_url: { type: 'string', minLength: 1, maxLength: 2048 },
            enabled: { type: 'boolean' },
          },
        },
        response: {
          200: channelObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.setChannel(request, reply),
  );

  app.delete(
    '/api/v1/notifications/channels/:type',
    {
      preHandler: channelWrite,
      schema: {
        tags,
        summary: 'Remove a delivery channel',
        params: channelParams,
        response: { 204: { type: 'null' }, 401: errorObject, 403: errorObject, 404: errorObject },
      },
    },
    (request, reply) => controller.deleteChannel(request, reply),
  );

  app.post(
    '/api/v1/notifications/channels/:type/test',
    {
      preHandler: channelWrite,
      schema: {
        tags,
        summary: 'Send a test message through this channel and report what the provider said',
        params: channelParams,
        response: {
          200: channelTestObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.testChannel(request, reply),
  );

  app.get(
    '/api/v1/notifications/preferences',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'List every notification event with this organization’s setting',
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: preferenceObject },
            },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.listPreferences(request, reply),
  );

  app.put(
    '/api/v1/notifications/preferences/:event',
    {
      preHandler: write,
      schema: {
        tags,
        summary: 'Enable/disable one event and set extra recipients',
        params: {
          type: 'object',
          required: ['event'],
          properties: { event: { type: 'string', enum: [...NOTIFICATION_EVENTS] } },
        },
        body: {
          type: 'object',
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
            recipients: { type: 'array', items: { type: 'string' } },
          },
        },
        response: {
          200: preferenceObject,
          400: errorObject,
          401: errorObject,
          403: errorObject,
          404: errorObject,
        },
      },
    },
    (request, reply) => controller.setPreference(request, reply),
  );

  app.get(
    '/api/v1/notifications',
    {
      preHandler: read,
      schema: {
        tags,
        summary: 'Delivery log — every notification and what happened to it',
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              object: { type: 'string' },
              data: { type: 'array', items: outboxObject },
            },
          },
          401: errorObject,
          403: errorObject,
        },
      },
    },
    (request, reply) => controller.listOutbox(request, reply),
  );
}
