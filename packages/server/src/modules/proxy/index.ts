/**
 * Proxy module public face (dependency-cruiser: only index.ts is cross-importable).
 * Wires the layers: service → controller → routes. The composition root (src/app.ts)
 * calls registerProxy; it never reaches inside the module.
 *
 * Layering (playbook §5): routes → controller → service → adapter/sse.
 * Proxy has no DB; when a module needs data it adds service → repository → queries.
 */
import type { FastifyInstance } from 'fastify';
import { createProxyService } from './services/proxy.service.js';
import { createProxyController } from './controllers/proxy.controller.js';
import { registerProxyRoutes } from './routes/proxy.routes.js';
import type { ProxyPreHandler } from './types/proxy.types.js';

export interface RegisterProxyOptions {
  upstreamUrl: string;
  // Data-plane auth (identity module). Resolves the virtual key + tenant context before the handler.
  // Optional so the offline `relay openapi` dump can register the route without an auth stack.
  authVirtualKey?: ProxyPreHandler;
}

export function registerProxy(app: FastifyInstance, opts: RegisterProxyOptions): void {
  const service = createProxyService();
  const controller = createProxyController({ service, upstreamUrl: opts.upstreamUrl });
  registerProxyRoutes(app, controller, opts.authVirtualKey);
}
