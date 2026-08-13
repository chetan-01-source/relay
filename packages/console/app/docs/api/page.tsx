/**
 * API reference — a map, not a mirror.
 *
 * The gateway already serves its own OpenAPI document and Swagger UI, generated from the route
 * schemas. Re-listing every endpoint here would create a second source of truth that goes stale the
 * first time somebody adds a field. So this page explains the two auth planes, the shapes that
 * repeat across every endpoint, and then sends you to the generated spec.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { DocBody, DocHeader, DocList, DocSection } from '../../../components/docs/doc-page';
import { CodeBlock, Callout } from '../../../components/docs/code-block';

export const metadata: Metadata = {
  title: 'API reference — Relay Gateway docs',
  description:
    'Two auth planes, the shapes every endpoint shares, and where the generated OpenAPI spec lives.',
};

export default function ApiDocsPage() {
  return (
    <>
      <DocHeader
        eyebrow="Integrate"
        title="API reference"
        lede="Relay has two APIs with two credentials. Knowing which is which explains most of the 401s people hit on their first afternoon."
      />

      <DocBody>
        <DocSection id="planes" title="Two planes, two credentials">
          <DocList
            rows={[
              {
                term: 'Data plane · /v1/*',
                detail: (
                  <>
                    OpenAI-compatible. Authenticated with a <strong>virtual key</strong> (
                    <code>rk_live_…</code>) scoped to one application. This is what your services
                    hold. Chat completions and model discovery live here.
                  </>
                ),
              },
              {
                term: 'Control plane · /api/v1/*',
                detail: (
                  <>
                    Configuration. Authenticated with a <strong>Logto access token</strong> for the
                    Relay API resource, carrying the organization it acts on. This is what the
                    console and your provisioning scripts hold.
                  </>
                ),
              },
            ]}
          />
          <Callout>
            <p>
              The two never cross. A virtual key cannot reach <code>/api/*</code> and an access
              token cannot proxy a completion — which is why{' '}
              <Link href="/docs/sdk#admin">the SDK models them as separate clients</Link> rather
              than one client with a mode flag.
            </p>
          </Callout>
        </DocSection>

        <DocSection id="spec" title="The generated spec">
          <p>
            Every endpoint, parameter and response shape is generated from the gateway&apos;s own
            route schemas, so it cannot drift from what the server actually accepts.
          </p>
          <DocList
            rows={[
              {
                term: 'GET /openapi.json',
                detail: 'The OpenAPI 3.1 document, served by your own deployment.',
              },
              {
                term: 'GET /docs',
                detail: 'Swagger UI, on the gateway port — try any endpoint against your instance.',
              },
              {
                term: 'api/postman/',
                detail: 'A generated Postman collection and environment in the repository.',
              },
            ]}
          />
          <p>
            The console&apos;s typed client and <code>@relay-ai/sdk</code> are both generated from
            that same document, which is what keeps all three in step.
          </p>
        </DocSection>

        <DocSection id="conventions" title="Conventions that hold everywhere">
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>Lists are enveloped.</strong>{' '}
              <code>{'{ "object": "list", "data": [...] }'}</code> — never a bare array, so a list
              can gain pagination without breaking a client.
            </li>
            <li>
              <strong>Pagination is keyset.</strong> <code>?before=&lt;cursor&gt;</code>, newest
              first. There are no page numbers; an offset over an append-only feed skips and repeats
              rows as it grows.
            </li>
            <li>
              <strong>Every object names its type.</strong> The <code>object</code> field (
              <code>application</code>, <code>budget</code>, <code>plan.effective</code>) makes a
              response self-describing in a log.
            </li>
            <li>
              <strong>Secrets are write-only.</strong> No read path returns a provider key, an SMTP
              password or a webhook URL — reads report whether one is set, never the value.
            </li>
            <li>
              <strong>Errors share one envelope.</strong> See{' '}
              <Link href="/docs/errors">Errors &amp; headers</Link>.
            </li>
          </ul>
        </DocSection>

        <DocSection id="scopes" title="Scopes">
          <p>
            Control-plane tokens carry scopes, and money-adjacent writes additionally require the
            caller to be an organization administrator — a scope says what kind of operation a token
            may perform, the role says who inside the tenant may perform it.
          </p>
          <CodeBlock
            label="scopes"
            copyable={false}
            code={`relay:read  relay:write
apps:read   apps:write
providers:read  providers:write
routes:read     routes:write
budgets:read    budgets:write      ← writes also require org admin
notifications:read  notifications:write
analytics:read
audit:read
platform:admin                     ← cross-tenant operator surface`}
          />
        </DocSection>
      </DocBody>
    </>
  );
}
