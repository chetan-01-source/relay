/**
 * Routing module interfaces (Week 2 Day 9). The data-plane proxy asks this library module for an
 * ordered failover plan: active route -> active version -> capable targets -> decrypted credentials.
 * The module has no HTTP surface; its public API is exported from index.ts for the composition root.
 */
import type { CanonicalRequest, ProviderName, Target } from '../../proxy/index.js';

export type RoutingStrategy = 'priority' | 'weighted';

export interface ModelCapabilities {
  modalities?: string[];
  max_tokens?: number;
  tools?: boolean;
  streaming?: boolean;
}

export interface RoutingTargetRow {
  route_id: string;
  route_version_id: string;
  strategy: RoutingStrategy;
  target_id: string;
  credential_id: string;
  provider: ProviderName;
  model: string;
  priority: number;
  weight: number;
  base_url: string | null;
  health_score: number;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  wrapped_dek: Buffer;
  capabilities: ModelCapabilities;
  input_usd_per_1k: string | null;
  output_usd_per_1k: string | null;
}

export interface RoutingRepository {
  listActiveTargets(model: string): Promise<RoutingTargetRow[]>;
}

export interface RoutingService {
  selectTargets(orgId: string, req: CanonicalRequest): Promise<Target[]>;
}
