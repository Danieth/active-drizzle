import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const alias = {
  '@/tests': resolve(__dirname, 'tests'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,

    reporter: ['verbose'],

    typecheck: {
      tsconfig: './tsconfig.test.json',
      include: ['tests/**/*.test-d.ts'],
    },

    coverage: {
      provider: 'v8',

      // Only instrument src/ — integration tests exercise the same code paths
      // as unit tests. Running coverage on integration tests adds heavy Docker
      // overhead on top of v8 instrumentation and will OOM on most machines.
      // Use: npx vitest run --coverage --project unit
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts',
        'src/vite/index.ts',
        'src/runtime/index.ts',
        'src/codegen/index.ts',
        // Exclude integration + benchmark from the coverage run — they spin up
        // Postgres containers which push RAM usage into the danger zone when
        // combined with v8 instrumentation. Run them separately with:
        //   npx vitest run tests/integration
        'tests/integration/**',
      ],

      reporter: [
        'text',
        'text-summary',
        'html',
        'lcov',
        'json-summary',
      ],

      reportsDirectory: './coverage',

      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
        perFile: true,
      },
    },

    // Two projects with different parallelism budgets. The old blanket
    // `maxForks: 1` served ONE purpose — keeping Docker containers from the
    // integration suites from running concurrently and blowing up RAM. That
    // constraint only applies to `tests/integration/**` (4 files). Everything
    // else is pure in-memory and safe to fan out across all cores.
    //   Full core suite: ~83s (serial) -> ~22s with this split.
    projects: [
      {
        // ---- UNIT: pure in-memory, no Docker. Fan out to every core. ----
        // isolate:true is REQUIRED here: several runtime tests depend on the
        // global DB registered via boot(); reusing worker context (isolate:false)
        // makes tests/runtime/transaction.test.ts flake. Do not "optimize" this
        // away without fixing that shared-singleton bleed first.
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**', '**/node_modules/**'],
          isolate: true,
          pool: 'forks',
          // No maxForks cap -> vitest uses all available cores.
          sequence: { setupFiles: 'list' },
        },
      },
      {
        // ---- INTEGRATION: one Postgres container per file. ----
        // Cap concurrency so at most 4 containers are alive at once. Each
        // postgres:16-alpine + pg pool is ~0.4-0.5 GB; 4 concurrent held well
        // under RAM on measured hardware. The old maxForks:1 serialised these
        // (~54s); 4-wide brings the integration lane to ~29s.
        resolve: { alias },
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          isolate: true,
          pool: 'forks',
          poolOptions: {
            forks: { maxForks: 4, minForks: 4 },
          },
          testTimeout: 300_000,
          hookTimeout: 90_000,
          sequence: { setupFiles: 'list' },
        },
      },
    ],
  },
})
