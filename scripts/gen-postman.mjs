#!/usr/bin/env node
/**
 * Generate a Postman collection (v2.1) + environment from the gateway's OpenAPI spec.
 *
 * The spec (api/openapi/openapi.json) is itself generated from the Fastify route schemas by
 * `pnpm --filter @relay-ai/server exec tsx src/cli/index.ts openapi`, so this script is the second hop
 * of a single pipeline: route schema -> OpenAPI -> Postman. Nothing here is hand-maintained, which is
 * why the collection cannot drift from the server contract.
 *
 * What it adds on top of a naive conversion:
 *  - Per-surface auth. The control plane (/api/v1/*) takes a Logto bearer; the data plane
 *    (/v1/chat/completions) takes a virtual key; model discovery is unauthenticated.
 *  - Example request bodies synthesised from the JSON Schema (enums/formats/field names respected).
 *  - Path parameters bound to collection variables, so a Runner pass chains end to end.
 *  - Post-response scripts that capture ids (org/app/key/provider/route) into those variables.
 *  - An `internal` folder for the ops listener (/healthz, /readyz, /metrics), which is deliberately
 *    absent from the public spec because it is served on a separate, non-public port.
 *
 * Usage: node scripts/gen-postman.mjs   (wired into `make generate`)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = resolve(ROOT, 'api/openapi/openapi.json');
const OUT_DIR = resolve(ROOT, 'api/postman');
const COLLECTION_PATH = resolve(OUT_DIR, 'relay-gateway.postman_collection.json');
const ENVIRONMENT_PATH = resolve(OUT_DIR, 'relay-local.postman_environment.json');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Path parameter name -> the collection variable that fills it, so a Runner pass chains. */
const PATH_VARIABLE = {
  orgId: 'org_id',
  appId: 'app_id',
  keyId: 'key_id',
  routeId: 'route_id',
  userId: 'user_id',
  requestId: 'request_id',
  model: 'model',
  id: 'provider_id', // only /api/v1/providers/{id} uses the bare name
};

/**
 * Post-response scripts that promote an id from a response into a collection variable. Keyed by
 * `METHOD path`. Written defensively (optional chaining + guards) so a failed call never throws in
 * the Runner — it just leaves the variable unset.
 */
const CAPTURE = {
  'POST /api/v1/platform/orgs': [['org_id', 'json.id']],
  'POST /api/v1/apps': [['app_id', 'json.id']],
  // The plaintext key is returned exactly once, on issue — capture it so the data-plane calls work.
  'POST /api/v1/apps/{appId}/keys': [
    ['key_id', 'json.id'],
    ['virtual_key', 'json.key'],
  ],
  'POST /api/v1/keys/{keyId}/rotate': [
    ['key_id', 'json.id'],
    ['virtual_key', 'json.key'],
  ],
  'POST /api/v1/providers': [['provider_id', 'json.id']],
  'POST /api/v1/routes': [['route_id', 'json.id']],
  'GET /api/v1/routes/{routeId}': [['route_version_id', 'json.versions?.[0]?.id']],
  'GET /api/v1/traffic': [['request_id', 'json.data?.[0]?.request_id']],
  'GET /api/v1/platform/orgs': [['org_id', 'json.data?.[0]?.id']],
  'GET /api/v1/apps': [['app_id', 'json.data?.[0]?.id']],
  'GET /api/v1/providers': [['provider_id', 'json.data?.[0]?.id']],
};

/** Which credential a request carries. `null` = inherit the collection default (Logto bearer). */
function authFor(path) {
  if (path.startsWith('/v1/models')) return 'noauth';
  if (path.startsWith('/v1/')) return 'virtualKey';
  return null;
}

// ── JSON Schema -> example value ────────────────────────────────────────────────────────────────

/** Field-name-driven string examples, so the generated bodies are runnable rather than "string". */
function stringExample(schema, name) {
  if (schema.format === 'uuid') {
    const varName = name === 'credential_id' ? 'provider_id' : `${name}`;
    return `{{${varName}}}`;
  }
  if (schema.format === 'uri' || name === 'baseUrl') return 'https://api.openai.com/v1';
  if (/email/i.test(name)) return 'admin@example.com';
  if (name === 'apiKey') return '{{provider_api_key}}';
  if (name === 'model' || name === 'model_name') return '{{model}}';
  if (name === 'provider') return 'openai';
  if (name === 'content') return 'Say hello from Relay in five words.';
  if (name === 'name') return 'My application';
  if (name === 'description') return 'Created from the Postman collection.';
  return name || 'string';
}

/** Build a representative value for a JSON Schema node. Deterministic — same spec, same bytes. */
function exampleOf(schema, name = '') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // A chat message defaults to the caller's turn, not the first enum member ('system').
    if (name === 'role' && schema.enum.includes('user')) return 'user';
    return schema.enum[0];
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0)
    return exampleOf(schema.anyOf[0], name);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
    return exampleOf(schema.oneOf[0], name);

  const type = Array.isArray(schema.type)
    ? (schema.type.find((t) => t !== 'null') ?? 'string')
    : schema.type;

  switch (type) {
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        out[key] = exampleOf(value, key);
      }
      return out;
    }
    case 'array':
      return [exampleOf(schema.items ?? { type: 'string' }, name)];
    case 'integer':
    case 'number':
      if (name === 'priority') return 0;
      if (name === 'weight') return 1;
      if (name === 'max_tokens') return 64;
      if (name === 'temperature') return 0.2;
      return schema.minimum ?? 1;
    case 'boolean':
      return name === 'stream' ? false : true;
    case 'null':
      return null;
    default:
      return stringExample(schema, name);
  }
}

/** A sensible default for a query parameter, shown (disabled) so the surface is discoverable. */
function queryExample(param) {
  const schema = param.schema ?? {};
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return String(schema.enum[0]);
  if (param.name === 'limit') return '50';
  if (param.name === 'from') return '2026-01-01';
  if (param.name === 'to') return '2026-12-31';
  if (param.name === 'before') return '1';
  return '';
}

// ── OpenAPI -> Postman ──────────────────────────────────────────────────────────────────────────

/** Split an OpenAPI path into Postman `path` segments, rewriting `{param}` to Postman's `:param`. */
function toSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith('{') && segment.endsWith('}') ? `:${segment.slice(1, -1)}` : segment,
    );
}

function pathParams(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/** The `event` block for a request: a shared 5xx guard plus any id-capture for this operation. */
function eventsFor(method, path) {
  const lines = [
    "pm.test('gateway did not 5xx', function () {",
    '  pm.expect(pm.response.code).to.be.below(500);',
    '});',
  ];
  const captures = CAPTURE[`${method.toUpperCase()} ${path}`];
  if (captures) {
    lines.push(
      '',
      'if (pm.response.code < 300) {',
      '  const json = pm.response.json();',
      ...captures.map(
        ([variable, expression]) =>
          `  if (${expression}) pm.collectionVariables.set('${variable}', ${expression});`,
      ),
      '}',
    );
  }
  return [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
}

function buildItem(method, path, operation) {
  const query = (operation.parameters ?? [])
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name,
      value: queryExample(p),
      disabled: !p.required,
      description: [p.description, p.schema?.enum ? `one of: ${p.schema.enum.join(', ')}` : null]
        .filter(Boolean)
        .join(' · '),
    }));

  const variable = pathParams(path).map((name) => ({
    key: name,
    value: `{{${PATH_VARIABLE[name] ?? name}}}`,
    description: `Path parameter · bound to the {{${PATH_VARIABLE[name] ?? name}}} collection variable`,
  }));

  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  const header = [{ key: 'accept', value: 'application/json' }];
  if (bodySchema) header.push({ key: 'content-type', value: 'application/json' });

  const request = {
    method: method.toUpperCase(),
    header,
    url: {
      raw: `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, ':$1')}${query.length > 0 ? '?' : ''}`,
      host: ['{{baseUrl}}'],
      path: toSegments(path),
      ...(query.length > 0 ? { query } : {}),
      ...(variable.length > 0 ? { variable } : {}),
    },
    description: operation.summary ?? '',
  };

  const auth = authFor(path);
  if (auth === 'noauth') request.auth = { type: 'noauth' };
  if (auth === 'virtualKey') {
    request.auth = {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{virtual_key}}', type: 'string' }],
    };
  }

  if (bodySchema) {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(exampleOf(bodySchema), null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  return {
    name: `${method.toUpperCase()} ${path}`,
    request,
    event: eventsFor(method, path),
    response: [],
  };
}

/** The internal ops listener is on its own port and is intentionally not in the public spec. */
function internalFolder() {
  const item = (name, segment, description) => ({
    name,
    request: {
      method: 'GET',
      header: [{ key: 'accept', value: '*/*' }],
      auth: { type: 'noauth' },
      url: { raw: `{{internalUrl}}/${segment}`, host: ['{{internalUrl}}'], path: [segment] },
      description,
    },
    response: [],
  });
  return {
    name: 'internal',
    description:
      'Ops listener (RELAY_INTERNAL_PORT, default 9090). Never exposed publicly — probes and scrapes only.',
    item: [
      item(
        'GET /healthz',
        'healthz',
        'Liveness. Touches no dependency, so a slow DB never restarts the process.',
      ),
      item(
        'GET /readyz',
        'readyz',
        'Readiness: Postgres + Valkey reachable AND the worker is warm. 503 when draining.',
      ),
      item('GET /metrics', 'metrics', 'Prometheus exposition for the gateway registry.'),
    ],
  };
}

function build(spec) {
  const byTag = new Map();
  for (const tag of spec.tags ?? []) byTag.set(tag.name, []);

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const tag = operation.tags?.[0] ?? 'default';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(buildItem(method, path, operation));
    }
  }

  const folders = [...byTag.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({
      name,
      description: (spec.tags ?? []).find((t) => t.name === name)?.description ?? '',
      item: items,
    }));
  folders.push(internalFolder());

  return {
    info: {
      name: `${spec.info.title} v${spec.info.version}`,
      description: [
        spec.info.description ?? '',
        '',
        'Generated from api/openapi/openapi.json by scripts/gen-postman.mjs — do not edit by hand;',
        'run `make generate` (or `node scripts/gen-postman.mjs`) after changing a route schema.',
        '',
        'Auth: the collection default is a Logto bearer ({{access_token}}) for the control plane',
        '(/api/v1/*). Chat completions carry a virtual key ({{virtual_key}}); model discovery is',
        'unauthenticated. Issuing a key (POST /api/v1/apps/{appId}/keys) captures {{virtual_key}}',
        'automatically, so a Runner pass over the folders works end to end.',
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }],
    },
    item: folders,
    variable: [
      { key: 'baseUrl', value: 'http://localhost:3000', type: 'string' },
      { key: 'internalUrl', value: 'http://localhost:9090', type: 'string' },
      { key: 'access_token', value: '', type: 'string' },
      { key: 'virtual_key', value: '', type: 'string' },
      { key: 'provider_api_key', value: '', type: 'string' },
      { key: 'model', value: 'gpt-4o-mini', type: 'string' },
      { key: 'org_id', value: '', type: 'string' },
      { key: 'app_id', value: '', type: 'string' },
      { key: 'key_id', value: '', type: 'string' },
      { key: 'provider_id', value: '', type: 'string' },
      { key: 'route_id', value: '', type: 'string' },
      { key: 'route_version_id', value: '', type: 'string' },
      { key: 'user_id', value: '', type: 'string' },
      { key: 'request_id', value: '', type: 'string' },
    ],
  };
}

function buildEnvironment() {
  const value = (key, val, secret = false) => ({
    key,
    value: val,
    type: secret ? 'secret' : 'default',
    enabled: true,
  });
  return {
    name: 'Relay — local',
    values: [
      value('baseUrl', 'http://localhost:3000'),
      value('internalUrl', 'http://localhost:9090'),
      value('access_token', '', true),
      value('virtual_key', '', true),
      value('provider_api_key', '', true),
      value('model', 'gpt-4o-mini'),
    ],
    _postman_variable_scope: 'environment',
  };
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(COLLECTION_PATH, `${JSON.stringify(build(spec), null, 2)}\n`);
writeFileSync(ENVIRONMENT_PATH, `${JSON.stringify(buildEnvironment(), null, 2)}\n`);

const operations = Object.values(spec.paths ?? {}).reduce(
  (n, pathItem) => n + HTTP_METHODS.filter((m) => pathItem[m]).length,
  0,
);
process.stdout.write(
  `[gen-postman] ${operations} operations + 3 internal probes -> ${COLLECTION_PATH}\n`,
);
