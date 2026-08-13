/**
 * Self-hosting.
 *
 * The master-key warning is placed BEFORE the compose commands rather than after. It is the one
 * mistake that is unrecoverable — every sealed credential is wrapped by that key — and a warning
 * that arrives below the command someone already ran is decoration.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { DocBody, DocHeader, DocList, DocSection } from '../../../components/docs/doc-page';
import { CodeBlock, Callout } from '../../../components/docs/code-block';

export const metadata: Metadata = {
  title: 'Self-hosting — Relay Gateway docs',
  description:
    'Run Relay in your own infrastructure: three containers, a master key, and no service we operate in the request path.',
};

export default function SelfHostDocsPage() {
  return (
    <>
      <DocHeader
        eyebrow="Run it yourself"
        title="Self-hosting"
        lede="Relay is Apache-2.0 and runs entirely in your infrastructure. Prompts, completions and provider credentials never transit a service we operate — because in this edition there is no service we operate."
      />

      <DocBody>
        <DocSection id="requirements" title="What it needs">
          <DocList
            rows={[
              {
                term: 'PostgreSQL 16',
                detail: 'With pgcrypto. Row-level security is forced on every tenant table.',
              },
              {
                term: 'Valkey 8',
                detail:
                  'Rate-limit buckets, budget counters, the exact cache, and snapshot invalidation.',
              },
              {
                term: 'The gateway image',
                detail: 'Signed, multi-arch, published to GHCR. Stateless — scale it horizontally.',
              },
              {
                term: 'Logto',
                detail: 'Identity for the console. The data plane (virtual keys) works without it.',
              },
            ]}
          />
        </DocSection>

        <DocSection id="master-key" title="Read this before you start">
          <Callout tone="warning" title="RELAY_MASTER_KEY is unrecoverable">
            <p>
              It wraps every sealed credential — provider keys, SMTP passwords, webhook URLs. Losing
              it means those values cannot be decrypted by anyone, including us. Generate it once,
              put it in your secret manager, and back it up separately from the database: a backup
              you cannot decrypt is not a backup.
            </p>
          </Callout>
          <CodeBlock label="generate" code={`openssl rand -base64 32`} />
        </DocSection>

        <DocSection id="compose" title="Bring it up">
          <CodeBlock
            label="shell"
            code={`tar -xzf relay-selfhost.tar.gz
cp .env.example .env          # set RELAY_MASTER_KEY and your database URL
docker compose up -d

curl -s localhost:9090/readyz  # {"status":"ready","pg":true,"valkey":true,"warm":true}`}
          />
          <p>
            Migrations are applied before the gateway serves, so there is no window where a worker
            is accepting traffic against a schema it does not have.
          </p>
        </DocSection>

        <DocSection id="operating" title="Operating it">
          <DocList
            rows={[
              {
                term: 'GET /healthz',
                detail:
                  'Liveness. Touches nothing, so a slow database never triggers a restart loop.',
              },
              {
                term: 'GET /readyz',
                detail:
                  'Readiness. Gated on Postgres, Valkey and the worker being fully wired — and it fails first on shutdown, so your load balancer drains the worker before anything is closed.',
              },
              {
                term: 'GET /metrics',
                detail:
                  'Prometheus. Request rate, gateway-only overhead, budget rejections, snapshot invalidation lag.',
              },
              {
                term: 'GET /openapi.json',
                detail: 'The machine-readable spec, with Swagger UI at /docs on the gateway port.',
              },
            ]}
          />
          <p>
            Graceful shutdown drains in-flight requests — including open SSE streams — before
            closing connections, with a hard timeout so a stuck stream cannot wedge a rolling
            deploy.
          </p>
        </DocSection>

        <DocSection id="limits" title="No limits, by design">
          <p>
            Every organization on a self-hosted install resolves to the built-in{' '}
            <code>self_hosted</code> plan: every numeric limit unlimited, every capability included,
            every quota check compiled out. The plan layer exists in the schema so a move to or from
            the hosted service is a data migration rather than a rewrite — but nothing in it can
            limit you. See <Link href="/docs/plans">Plans &amp; quotas</Link>.
          </p>
        </DocSection>

        <DocSection id="backups" title="Backups">
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong>Postgres is the source of truth.</strong> Valkey holds only counters and
              cache; losing it costs you an in-flight rate-limit window, not data — budget counters
              reseed from durable spend on the next cold read.
            </li>
            <li>
              <strong>Back up the master key separately.</strong> Keeping it beside the dump means a
              single leak yields both the ciphertext and the key to it.
            </li>
            <li>
              <strong>Test a restore.</strong> The repository ships <code>scripts/backup.sh</code>{' '}
              and <code>scripts/restore.sh</code> so this is a habit rather than a project.
            </li>
          </ul>
        </DocSection>
      </DocBody>
    </>
  );
}
