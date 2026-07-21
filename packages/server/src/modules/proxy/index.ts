/**
 * Proxy module public face (dependency-cruiser: only index.ts is cross-importable).
 * Wires the layers: service → controller → routes. The composition root (src/app.ts)
 * calls registerProxy; it never reaches inside the module.
 *
 * Layering (playbook §5): routes → controller → service → adapter/sse. Route target selection is
 * injected from the routing module so proxy still owns provider I/O, not SQL.
 */
import type { FastifyInstance } from 'fastify';
import { createProxyService } from './services/proxy.service.js';
import { createProxyController } from './controllers/proxy.controller.js';
import { registerProxyRoutes } from './routes/proxy.routes.js';
import type {
  ProxyPolicyService,
  ProxyPreHandler,
  ProxyRoutingService,
} from './types/proxy.types.js';

export type { CanonicalRequest, ContentPart, ProviderName, Target } from './types/proxy.types.js';

export interface RegisterProxyOptions {
  routing: ProxyRoutingService;
  policy: ProxyPolicyService;
  // Data-plane auth (identity module). Resolves the virtual key + tenant context before the handler.
  // Optional so the offline `relay openapi` dump can register the route without an auth stack.
  authVirtualKey?: ProxyPreHandler;
}

export function registerProxy(app: FastifyInstance, opts: RegisterProxyOptions): void {
  const service = createProxyService();
  const controller = createProxyController({ service, routing: opts.routing, policy: opts.policy });
  registerProxyRoutes(app, controller, opts.authVirtualKey);
}
