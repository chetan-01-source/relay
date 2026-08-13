/**
 * Policy module public face. Library module only; the proxy receives PolicyService through DI.
 */
import { createPolicyService } from './services/policy.service.js';
import { createPolicyRepository } from './repositories/policy.repository.js';

export { createPolicyService, createPolicyRepository };
export type { SpendReader, BudgetAlertSink } from './types/policy.types.js';
export type { PolicyDecision, PolicyService, UsageTokens } from './types/policy.types.js';
