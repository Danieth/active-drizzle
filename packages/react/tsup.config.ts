import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  jsx: 'react',
  external: [
    '@active-drizzle/core',
    '@active-drizzle/controller',
    'react',
    'react/jsx-runtime',
    '@tanstack/react-query',
    '@tanstack/react-form',
  ],
})
