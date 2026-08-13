/**
 * CSV export proxy for the usage reports. The gateway already renders CSV (`format=csv` on both
 * analytics endpoints) but needs a Logto bearer, which the browser does not hold — so this
 * same-origin route handler attaches the caller's token server-side and re-serves the body as a
 * download. The console never formats the CSV itself: the gateway owns that shape, and this handler
 * is a pipe, so an added column appears in the download without a console change.
 */
import { getPlan, getUsageCsv, type UsageQuery } from '../../../lib/api';
import { requireUser, hasScope } from '../../../lib/auth';
import { parseGrouping, apiWindow } from '../../../lib/analytics';
import { isEnabled } from '../../../lib/plan';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const me = await requireUser();
  const params = new URL(request.url).searchParams;
  const scope = params.get('scope') === 'platform' ? 'platform' : 'org';

  // The gateway enforces this too (403 on a token without platform:admin); refusing here keeps the
  // console from issuing a call it knows will fail and leaking a confusing 500 into the download.
  if (scope === 'platform' && !me.is_platform_admin) {
    return new Response('forbidden', { status: 403 });
  }
  if (scope === 'org' && !hasScope(me, 'analytics:read')) {
    return new Response('forbidden', { status: 403 });
  }

  // `analytics.export` is a plan capability (docs/plans.md §3), and this handler is the only place a
  // CSV is produced — so this is where it is enforced. Deliberately NOT enforced on the gateway's
  // usage API: that data is available on every plan, and a gate anyone could walk around with curl
  // is worse than no gate. A platform admin exporting the cross-tenant report is exempt; that report
  // is an operator tool, not a tenant feature.
  if (scope === 'org') {
    const allowed = await getPlan()
      .then((plan) => isEnabled(plan, 'analytics.export'))
      // A plan lookup that fails must not block an export the customer is entitled to.
      .catch(() => true);
    if (!allowed) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Analytics export is not included in this organization’s plan.',
            type: 'permission_error',
            code: 'plan_upgrade_required',
            param: 'analytics.export',
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    }
  }

  const groupBy = parseGrouping(params.get('group_by'));
  const from = params.get('from');
  const to = params.get('to');
  // The link carries the picker's INCLUSIVE dates; the endpoint's `to` is exclusive. Convert here so
  // the CSV covers exactly the window the table on screen showed — a download that quietly omitted
  // the final day would be worse than the bug it came from.
  const range = from && to ? apiWindow({ from, to }) : null;
  const query: UsageQuery = {
    group_by: groupBy,
    ...(range ? range : { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  };

  let csv: string;
  try {
    csv = await getUsageCsv(scope, query);
  } catch {
    return new Response('usage export unavailable', { status: 502 });
  }

  const label = scope === 'platform' ? 'platform' : groupBy;
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="relay-${label}-usage.csv"`,
      'cache-control': 'no-store',
    },
  });
}
