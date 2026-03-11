import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@active-drizzle/core': resolve(__dirname, '../core/src/index.ts'),
      '@active-drizzle/controller': resolve(__dirname, 'src/index.ts'),
    },
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1 } },
    testTimeout: 300_000,
    hookTimeout: 90_000,
  },
})
