/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'module-internals-are-private',
      comment: 'Only modules/*/index.ts is cross-importable (PRD §15)',
      severity: 'error',
      from: { path: '^packages/server/src/modules/([^/]+)/' },
      to: {
        path: '^packages/server/src/modules/([^/]+)/(?!index\\.ts)',
        pathNot: '^packages/server/src/modules/$1/',
      },
    },
    {
      name: 'platform-never-imports-modules',
      comment: 'kernel (platform/) is the bottom layer — one-way dependency',
      severity: 'error',
      from: { path: '^packages/server/src/platform/' },
      to: { path: '^packages/server/src/modules/' },
    },
    {
      name: 'no-cross-package-src',
      comment: 'packages talk via workspace deps + published types, not deep paths',
      severity: 'error',
      from: { path: '^packages/([^/]+)/' },
      to: { path: '^packages/[^/]+/src/', pathNot: '^packages/$1/' },
    },
    {
      name: 'core-never-imports-cloud',
      comment:
        'The commercial packages/cloud may import the Apache-2.0 core; never the reverse. ' +
        'Enforced mechanically because a convention here rots within a quarter (docs/editions.md §4).',
      severity: 'error',
      from: { path: '^packages/(server|console|sdk|shared)/' },
      to: { path: '^packages/cloud/' },
    },
    {
      name: 'sdk-is-standalone',
      comment:
        'The SDK is published to npm, so it may not import a private workspace package — an install ' +
        'would fail. Shared types are duplicated there deliberately (packages/sdk/src/errors.ts).',
      severity: 'error',
      from: { path: '^packages/sdk/' },
      to: { path: '^packages/(server|console|shared)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
};
