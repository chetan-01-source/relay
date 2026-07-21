/**
 * Routing service — business logic only. Converts an active route version into an ordered failover
 * plan, applies capability filters, and opens provider credentials only at send time.
 */
import { RelayError } from '@relay/shared';
import { openCredential } from '../../../platform/crypto.js';
import type { Database } from '../../../platform/db.js';
import type { CanonicalRequest, Target } from '../../proxy/index.js';
import { createRoutingRepository } from '../repositories/routing.repository.js';
import type { ModelCapabilities, RoutingTargetRow } from '../types/routing.types.js';

export interface RoutingServiceDeps {
  db: Database;
  masterKey: string;
  fallbackBaseUrl: string;
}

interface CachedTargets {
  expiresAt: number;
  rows: RoutingTargetRow[];
}

const ROUTE_CACHE_MS = 60_000;

export function createRoutingService(deps: RoutingServiceDeps) {
  const scope = { isPlatformAdmin: false };
  const cache = new Map<string, CachedTargets>();

  async function selectTargets(orgId: string, req: CanonicalRequest): Promise<Target[]> {
    const rows = await loadTargets(orgId, req.model);
    if (rows.length === 0) {
      throw new RelayError('model_not_found', {
        message: `No active route for model '${req.model}'.`,
      });
    }

    const capable = rows.filter((row) => supportsRequest(row.capabilities, req));
    if (capable.length === 0) {
      throw new RelayError('model_capability_mismatch', {
        message: `No route target supports the requested capability for '${req.model}'.`,
      });
    }

    return orderTargets(capable).map((row) => {
      const apiKey = openCredential(deps.masterKey, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        wrappedDek: row.wrapped_dek,
      });
      const inputUsdPer1k = money(row.input_usd_per_1k);
      const outputUsdPer1k = money(row.output_usd_per_1k);
      return {
        provider: row.provider,
        model: row.model,
        baseUrl: row.base_url ?? defaultBaseUrl(row.provider, deps.fallbackBaseUrl),
        apiKey,
        routeTargetId: row.target_id,
        credentialId: row.credential_id,
        breakerKey: `${row.credential_id}:${row.model}`,
        ...(inputUsdPer1k !== undefined ? { inputUsdPer1k } : {}),
        ...(outputUsdPer1k !== undefined ? { outputUsdPer1k } : {}),
      };
    });
  }

  return { selectTargets };

  async function loadTargets(orgId: string, model: string): Promise<RoutingTargetRow[]> {
    const key = `${orgId}:${model}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const rows = await deps.db.withTenant(orgId, scope, async (tx) =>
      createRoutingRepository(tx).listActiveTargets(model),
    );
    if (rows.length > 0) cache.set(key, { rows, expiresAt: Date.now() + ROUTE_CACHE_MS });
    return rows;
  }
}

function requestedModalities(req: CanonicalRequest): Set<string> {
  const modalities = new Set<string>(['text']);
  for (const message of req.messages) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'image_url') modalities.add('image');
      }
    }
  }
  return modalities;
}

function supportsRequest(capabilities: ModelCapabilities, req: CanonicalRequest): boolean {
  const supported = new Set(capabilities.modalities ?? ['text']);
  for (const modality of requestedModalities(req)) {
    if (!supported.has(modality)) return false;
  }
  if (req.stream && capabilities.streaming === false) return false;
  if (req.max_tokens && capabilities.max_tokens && req.max_tokens > capabilities.max_tokens) {
    return false;
  }
  return true;
}

function orderTargets(rows: RoutingTargetRow[]): RoutingTargetRow[] {
  const strategy = rows[0]?.strategy ?? 'priority';
  const sorted = [...rows].sort(
    (a, b) => a.priority - b.priority || b.health_score - a.health_score,
  );
  if (strategy !== 'weighted') return sorted;

  const total = sorted.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  if (total <= 0) return sorted;

  let ticket = Math.random() * total;
  const primary =
    sorted.find((row) => {
      ticket -= Math.max(0, row.weight);
      return ticket <= 0;
    }) ?? sorted[0]!;
  return [primary, ...sorted.filter((row) => row.target_id !== primary.target_id)];
}

function defaultBaseUrl(provider: string, fallback: string): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'openai') return 'https://api.openai.com';
  return fallback;
}

function money(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
