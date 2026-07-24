# @relay/console

The Relay management console — a Next.js App Router app (SSR) for the **onboarding → build → operate**
flow. Runs on `:3100`; talks to the gateway control plane on `:3000`. See ADR `0011`.

## Layout

```
app/
├── layout.tsx            root shell (imports globals.css)
├── page.tsx              landing / Logto sign-in → links into the console
├── (console)/           authenticated area (shared nav shell)
│   ├── layout.tsx        gates on requireUser(); renders nav + top bar
│   ├── dashboard/        spend/usage tiles + setup checklist + spend-by-model
│   ├── apps/             applications list/create + [appId] keys (create/rotate/revoke)
│   ├── providers/        write-only credential forms + delete
│   └── audit/            hash-chained audit trail viewer
├── orgs/                 platform-admin org + entitlements (Week 2)
└── lib/
    ├── api.ts            typed control-plane client (bearer token; server-only)
    ├── api-types.ts      GENERATED from OpenAPI (`make generate`) — do not edit
    ├── auth.ts           requireUser / requireOrg / requireAdmin (server-side gates)
    ├── usage.ts          dashboard aggregation (pure, tested)
    ├── checklist.ts      setup-checklist derivation (pure, tested)
    └── snippet.ts        cURL / Python / Node snippet builder (pure, tested)
components/
├── ui/                   shadcn primitives (button/card/input/label/table/dialog/badge)
└── *.tsx                 feature components (forms, dialogs, snippet drawer, nav)
test/e2e/                 Playwright specs (gating = no auth; build-flow = seeded session)
```

## Conventions

- **Auth is server-side.** Gate every protected page with `requireUser`/`requireOrg`/`requireAdmin`;
  never rely on hiding UI. The gateway still enforces scopes on every call.
- **All data via the typed client.** `api-types.ts` is generated — after any endpoint change run
  `make generate` and commit `openapi.json` + `api-types.ts` together.
- **Mutations are server actions** that call `api.ts` and `revalidatePath`.
- **One-time keys / write-only secrets:** reveal a key's plaintext once (copy + snippet); provider
  secret fields are password inputs and are never read back.
- **Pure logic lives in `lib/*.ts`** and is unit-tested; components stay thin.

## Scripts

```bash
pnpm dev         # next dev on :3100
pnpm build       # production build (also type-checks routes)
pnpm test        # vitest unit tests (pure lib)
pnpm e2e         # playwright (needs the stack up: make dev)
pnpm gen:api     # regenerate api-types.ts from the OpenAPI spec
```
