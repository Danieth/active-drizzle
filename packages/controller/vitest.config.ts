import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      // Subpath exports must come first — the bare-package alias below is a
      // prefix match and would otherwise mangle them into ".../index.ts/<sub>"
      '@active-drizzle/core/validators': resolve(__dirname, '../core/src/runtime/validators.ts'),
      '@active-drizzle/core': resolve(__dirname, '../core/src/index.ts'),
      '@active-drizzle/controller': resolve(__dirname, 'src/index.ts'),
      '@active-drizzle/react': resolve(__dirname, '../react/src/index.ts'),
    },
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    // maxForks:1 is deliberate and OPTIMAL here — not a Docker constraint.
    // Only 6 test files, but each fork re-transforms the whole core src tree
    // (imported via the @active-drizzle/core alias). A single fork transforms
    // it once and reuses the module cache across all files (~3.8s); fanning out
    // duplicates that transform per fork and is measurably SLOWER (~5.8s).
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1 } },
    testTimeout: 300_000,
    hookTimeout: 90_000,

    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
})
