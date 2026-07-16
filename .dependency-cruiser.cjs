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
