import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@/tests': resolve(__dirname, 'tests'),
    },
  },
  test: {
    globals: true,
    environment: 'node',

    reporter: ['verbose'],

    include: ['tests/**/*.test.ts'],

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

    // Each test file gets its own worker context — no global state bleed.
    isolate: true,

    // Run test files one at a time so at most one Docker container is alive.
    // With 3 integration suites running concurrently (ecommerce + rails-methods
    // + benchmark) the peak RSS was >40 GB due to Testcontainers + pg pools.
    pool: 'forks',
    poolOptions: {
      forks: {
        // One worker at a time: serialises Docker lifecycle across suites.
        // Unit tests are fast anyway; this costs ~2 s on the full suite.
        maxForks: 1,
      },
    },

    // Integration + benchmark tests spin up Docker containers and run many DB
    // round-trips. 5 minutes per test suite is the ceiling.
    testTimeout: 300_000,
    hookTimeout: 90_000,

    sequence: {
      setupFiles: 'list',
    },
  },
})
