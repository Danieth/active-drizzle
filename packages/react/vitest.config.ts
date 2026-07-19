import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@active-drizzle/core/validators': resolve(__dirname, '../core/src/runtime/validators.ts'),
      '@active-drizzle/core': resolve(__dirname, '../core/src/index.ts'),
      '@active-drizzle/controller': resolve(__dirname, '../controller/src/index.ts'),
    },
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // No Docker here — pure jsdom. Fan out across all cores (was capped at 2).
    // isolate stays at vitest's default (true): react tests also touch the
    // global boot() registry, so reusing worker context can bleed.
    pool: 'forks',
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
