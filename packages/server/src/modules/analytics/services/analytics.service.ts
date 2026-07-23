/**
 * Analytics service (DEVELOPMENT.md §2) — business logic. Opens the tenant transaction so RLS scopes
 * the rollups, then maps persistence rows to API buckets. No SQL, no HTTP — depends only on the
 * Database handle and the AnalyticsRepository interface, so it is unit-testable with fakes.
 */
import type { Database } from '../../../platform/db.js';
import type {
  AnalyticsRepository,
  AnalyticsService,
  UsageAggregateRow,
  UsageBucket,
  UsageQueryOptions,
  UsageSummary,
} from '../types/analytics.types.js';

/** The nil UUID stands in for `app.current_org` on the platform-admin cross-org read: the
 * `platform_admin_access` RLS policy grants visibility regardless of current_org, so the value only
 * has to be a syntactically valid uuid. Mirrors the metering rollup worker's platform-admin read. */
const PLATFORM_ADMIN_ORG = '00000000-0000-0000-0000-000000000000';

/** pg returns bigint/numeric aggregates as strings (and NULL for an empty group); coerce to a number. */
function num(value: string | null): number {
  return value === null ? 0 : Number(value);
}

function toBucket(row: UsageAggregateRow): UsageBucket {
  return {
    key: row.group_key ?? '(none)', // route_id is nullable → NULL groups collapse to a labeled bucket
    requests: num(row.requests),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    cost_usd: num(row.cost_usd),
  };
}

export interface AnalyticsServiceDeps {
  db: Database;
  repo: AnalyticsRepository;
}

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  return {
    async getUsage(orgId: string, opts: UsageQueryOptions): Promise<UsageSummary> {
      const rows = await deps.db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
        deps.repo.sumUsage(tx, opts.groupBy, {
          byOrg: false,
          ...(opts.from ? { from: opts.from } : {}),
          ...(opts.to ? { to: opts.to } : {}),
        }),
      );
      return { object: 'analytics.usage', group_by: opts.groupBy, data: rows.map(toBucket) };
    },

    async getUsageAllOrgs(opts: { from?: string; to?: string }): Promise<UsageSummary> {
      const rows = await deps.db.withTenant(PLATFORM_ADMIN_ORG, { isPlatformAdmin: true }, (tx) =>
        // groupBy is ignored when byOrg is set; the query keys by org_id.
        deps.repo.sumUsage(tx, 'model', {
          byOrg: true,
          ...(opts.from ? { from: opts.from } : {}),
          ...(opts.to ? { to: opts.to } : {}),
        }),
      );
      return { object: 'analytics.usage', group_by: 'org', data: rows.map(toBucket) };
    },
  };
}
