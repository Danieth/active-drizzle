# folded into README.md (2026-08-26)

All queued sections were folded. None were dropped; no `TODO(verify)` markers
were needed — every referenced API was verified against
`packages/{core,controller,react}/src/index.ts` (and `packages/trails/bin`)
before folding.

Notes from the fold:

- Verification notes ("*Verified end-to-end…*") were trimmed per this file's
  own header instruction.
- The Concerns section's claim that everything "ships from `active-drizzle`"
  was corrected to `@active-drizzle/core` (the bare name is not a package).
- The presenter-platform testing kit is documented at its real subpath,
  `@active-drizzle/react/testing`.
- Bug-history sections (has-many-through `source`, the tsc-clean batch,
  STI bug #6) were folded as their resulting behavior (feature bullets and
  teaching-error notes), not as changelog narrative.
