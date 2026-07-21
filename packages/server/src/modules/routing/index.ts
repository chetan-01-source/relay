/**
 * Routing module public face. This is a data-plane library module (no routes): the proxy receives
 * its RoutingService through DI and never imports routing internals.
 */
import { createRoutingService } from './services/routing.service.js';

export { createRoutingService };
export type { RoutingService } from './types/routing.types.js';
