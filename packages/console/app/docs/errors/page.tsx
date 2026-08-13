/**
 * Errors & headers — the wire contract.
 *
 * One page, not two, because they are read together: something came back wrong, and the answer is
 * either in the error code or in the headers beside it. Splitting them would mean two lookups for
 * one question.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { DocBody, DocHeader, DocSection } from '../../../components/docs/doc-page';
import { CodeBlock, Callout } from '../../../components/docs/code-block';

export const metadata: Metadata = {
  title: 'Errors & headers — Relay Gateway docs',
  description:
    'The OpenAI-compatible error envelope, every Relay error code, and the x-relay-* response headers.',
};

const ERRORS: Array<{ code: string; status: string; meaning: string }> = [
  {
    code: 'invalid_request',
    status: '400',
    meaning: 'The request body or parameters are malformed.',
  },
  {
    code: 'invalid_api_key',
    status: '401',
    meaning: 'The virtual key is missing, malformed or unknown.',
  },
  {
    code: 'key_revoked',
    status: '401',
    meaning: 'The key existed and has been revoked, or its rotation grace window expired.',
  },
  {
    code: 'insufficient_scope',
    status: '403',
    meaning:
      'The caller is authenticated but not permitted — a missing scope, or not an organization administrator.',
  },
  {
    code: 'org_suspended',
    status: '403',
    meaning:
      'The organization is suspended. Every key it owns is refused within about a second of the suspension.',
  },
  {
    code: 'plan_upgrade_required',
    status: '403',
    meaning: 'The capability is not included in the plan. `param` names it.',
  },
  {
    code: 'not_found',
    status: '404',
    meaning:
      'No such resource — or one belonging to another tenant, which is reported identically on purpose.',
  },
  {
    code: 'model_not_found',
    status: '404',
    meaning: 'No route or catalog entry matches the requested model alias.',
  },
  {
    code: 'model_capability_mismatch',
    status: '400',
    meaning: 'No target on the route supports what the request needs (for example an image input).',
  },
  {
    code: 'quota_exceeded',
    status: '409',
    meaning: 'A countable plan quota is full. `param` names it.',
  },
  {
    code: 'conflict',
    status: '409',
    meaning: 'The resource already exists, or conflicts with one that does.',
  },
  {
    code: 'payload_too_large',
    status: '413',
    meaning: 'The request body exceeds the gateway limit.',
  },
  {
    code: 'rate_limited',
    status: '429',
    meaning: 'A requests- or tokens-per-minute ceiling. `retry-after` says how long to wait.',
  },
  {
    code: 'budget_exceeded',
    status: '429',
    meaning:
      'A spend ceiling with a hard cutoff — the organization’s, an application’s, or the plan’s.',
  },
  {
    code: 'upstream_error',
    status: '502',
    meaning: 'The provider returned an error and no other target succeeded.',
  },
  { code: 'upstream_unreachable', status: '502', meaning: 'No target could be reached at all.' },
  {
    code: 'internal_error',
    status: '500',
    meaning: 'A gateway fault. Details go to the logs, never to the client.',
  },
  {
    code: 'service_unavailable',
    status: '503',
    meaning: 'A dependency the request needed is unavailable. Retry shortly.',
  },
];

const HEADERS: Array<{ name: string; value: string }> = [
  {
    name: 'x-relay-trace-id',
    value:
      'Correlation id. The same value indexes the Live traffic view and the request’s usage event.',
  },
  {
    name: 'x-relay-provider',
    value: 'The upstream that actually served the request, or `cache` on a hit.',
  },
  { name: 'x-relay-cache', value: '`miss` or `hit-exact`.' },
  { name: 'x-relay-failover', value: '`true` when a lower-priority target took the request.' },
  {
    name: 'x-relay-cost-usd',
    value: 'Settled cost to six decimal places. See the streaming caveat below.',
  },
  {
    name: 'x-relay-modalities',
    value: 'Comma list: `text` always, plus `image` when a message carried one.',
  },
  {
    name: 'x-relay-plan',
    value:
      'The plan the enforced ceilings came from. Absent when the deployment has no plan layer.',
  },
  { name: 'x-ratelimit-limit-requests', value: 'The rpm ceiling in force for this key.' },
  { name: 'x-ratelimit-remaining-requests', value: 'Requests left in the current window.' },
  { name: 'x-ratelimit-limit-tokens', value: 'The tpm ceiling in force for this key.' },
  { name: 'x-ratelimit-remaining-tokens', value: 'Tokens left in the current window.' },
  { name: 'retry-after', value: 'Seconds to wait. Present on a 429.' },
];

export default function ErrorsDocsPage() {
  return (
    <>
      <DocHeader
        eyebrow="Integrate"
        title="Errors & headers"
        lede="Relay speaks OpenAI's error envelope, so existing SDKs surface its failures as native API errors. Every response also carries the x-relay-* headers that say what actually happened to the request."
      />

      <DocBody>
        <DocSection id="envelope" title="The envelope">
          <CodeBlock
            label="every error, without exception"
            copyable={false}
            code={`{
  "error": {
    "message": "Organization budget limit reached.",
    "type":    "rate_limit_error",
    "code":    "budget_exceeded",
    "param":   null
  }
}`}
          />
          <p>
            <code>code</code> is the stable identifier — branch on it. <code>type</code> exists for
            OpenAI-SDK compatibility, and <code>param</code> names the field, quota or capability
            the error is about.
          </p>
        </DocSection>

        <DocSection id="codes" title="Error codes">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="px-4 py-2.5 font-medium text-foreground">Code</th>
                  <th className="px-4 py-2.5 font-medium text-foreground">HTTP</th>
                  <th className="px-4 py-2.5 font-medium text-foreground">Meaning</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ERRORS.map((row) => (
                  <tr key={row.code}>
                    <td className="px-4 py-3 align-top font-mono text-xs text-foreground">
                      {row.code}
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-xs tabular-nums">
                      {row.status}
                    </td>
                    <td className="px-4 py-3 align-top leading-relaxed">{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Callout title="Why a foreign tenant's resource returns 404">
            <p>
              Reporting <code>403</code> would confirm that the id exists, which is a membership
              oracle. Ids are unguessable, but &ldquo;unguessable&rdquo; is not an authorization
              model, so an inaccessible resource is indistinguishable from an absent one.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="headers" title="Response headers">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="px-4 py-2.5 font-medium text-foreground">Header</th>
                  <th className="px-4 py-2.5 font-medium text-foreground">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {HEADERS.map((row) => (
                  <tr key={row.name}>
                    <td className="px-4 py-3 align-top font-mono text-xs text-foreground">
                      {row.name}
                    </td>
                    <td className="px-4 py-3 align-top leading-relaxed">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Callout tone="warning" title="Cost on a streamed response">
            <p>
              Token usage arrives in the final SSE frame, after the headers have already been sent —
              so <code>x-relay-cost-usd</code> on a stream reflects only what was known at header
              time, usually <code>0.000000</code>. The settled cost always lands on the usage event
              and the analytics rollups. Bill from those, never from the streaming header.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="retrying" title="What is worth retrying">
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>429</strong> — yes, after <code>retry-after</code>. A{' '}
              <code>rate_limited</code> will clear within the minute; a <code>budget_exceeded</code>{' '}
              will not clear until the period rolls or the ceiling moves, so back off hard rather
              than hammering.
            </li>
            <li>
              <strong>502 / 503</strong> — yes, with jitter. Relay has already tried every target on
              the route before returning one.
            </li>
            <li>
              <strong>4xx otherwise</strong> — no. The request is the problem; retrying it changes
              nothing and costs you rate-limit budget.
            </li>
            <li>
              <strong>Anything already streaming</strong> — never. A re-sent completion is billed
              twice for one answer. <Link href="/docs/sdk#retries">The SDK enforces this.</Link>
            </li>
          </ul>
        </DocSection>
      </DocBody>
    </>
  );
}
