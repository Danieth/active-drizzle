import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    validators: 'src/runtime/validators.ts',
    // The isomorphic frame codec — a ZERO-drizzle subpath so browser bundles
    // get the wire codec without the ORM (transport WS4; one codec, one wire).
    frames: 'src/transport/frame-codec.ts',
    'vite/index': 'src/vite/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  external: ['drizzle-orm', 'vite', 'typescript'],
})
