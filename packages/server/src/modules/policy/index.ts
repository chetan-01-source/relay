/**
 * Policy module public face. Library module only; the proxy receives PolicyService through DI.
 */
import { createPolicyService } from './services/policy.service.js';

export { createPolicyService };
export type { PolicyDecision, PolicyService, UsageTokens } from './types/policy.types.js';
