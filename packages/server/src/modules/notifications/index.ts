/**
 * Notifications module public face (dependency-cruiser: only index.ts is cross-importable).
 *
 * Two surfaces:
 *   • registerNotifications — the tenant-facing config API (channel, preferences, delivery log).
 *   • the returned NotificationEnqueuer — the write side other modules produce events through,
 *     enqueuing inside THEIR transaction so a notification commits with the change that caused it.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries, plus lib/.
 */
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../platform/db.js';
import type { LogtoOrgSync } from '../../platform/logto.js';
import { createAuditRepository } from '../audit/index.js';
import type { AuthPreHandler } from '../identity/index.js';
import { createNotificationsRepository } from './repositories/notifications.repository.js';
import type { PlansService } from '../plans/index.js';
import { createNotificationsService } from './services/notifications.service.js';
import { createNotificationsController } from './controllers/notifications.controller.js';
import { registerNotificationsRoutes } from './routes/notifications.routes.js';
import { createDispatcher, type Dispatcher } from './services/dispatcher.js';
import { createConsoleSender, type EmailSender } from './services/sender.js';
import type { NotificationEnqueuer } from './types/notifications.types.js';

export { NOTIFICATION_EVENTS, EVENT_CATALOGUE, dedupeKeyFor } from './lib/events.js';
export type { NotificationEvent } from './lib/events.js';
export type { NotificationEnqueuer } from './types/notifications.types.js';
export { createConsoleSender, createSmtpSender } from './services/sender.js';
export { createBudgetAlertSink } from './services/budget-alerts.js';
export type { EmailSender } from './services/sender.js';

export interface RegisterNotificationsOptions {
  db: Database;
  masterKey: string;
  guards: {
    authJwt: AuthPreHandler;
    requireScope: (...scopes: string[]) => AuthPreHandler;
    requireOrgAdmin: () => AuthPreHandler;
  };
  /** Platform fallback transport. Defaults to the console sender — nothing leaves the machine. */
  platformSender?: EmailSender;
  platformFrom?: string;
  logto?: LogtoOrgSync | undefined;
  consoleUrl?: string | undefined;
  dispatchIntervalMs?: number;
  /** Gates Slack/Teams channels behind `notifications.chat`. Absent ⇒ ungated. */
  plans?: PlansService;
}

export interface NotificationsHandles {
  /** Other modules produce events through this. */
  enqueuer: NotificationEnqueuer;
  /** The delivery worker; the composition root starts and stops it. */
  dispatcher: Dispatcher;
}

export function registerNotifications(
  app: FastifyInstance,
  opts: RegisterNotificationsOptions,
): NotificationsHandles {
  const service = createNotificationsService({
    db: opts.db,
    repo: createNotificationsRepository(),
    audit: createAuditRepository(),
    masterKey: opts.masterKey,
    ...(opts.plans ? { plans: opts.plans } : {}),
  });

  const controller = createNotificationsController(service);
  registerNotificationsRoutes(app, controller, opts.guards);

  const dispatcher = createDispatcher({
    db: opts.db,
    masterKey: opts.masterKey,
    platformSender: opts.platformSender ?? createConsoleSender(),
    platformFrom: opts.platformFrom ?? 'relay@localhost',
    logto: opts.logto,
    consoleUrl: opts.consoleUrl,
    ...(opts.dispatchIntervalMs ? { intervalMs: opts.dispatchIntervalMs } : {}),
  });

  return { enqueuer: service, dispatcher };
}
