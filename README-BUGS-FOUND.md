
---

## 3. `npm run typecheck` is not clean (pre-existing) — generated code doesn't pass `tsc`

**Symptom.** `tsc --noEmit` reports errors that don't affect the running app:

- `deal.gen.ts` does `import type { NoteAttrs } from './note.gen'` for every
  **nested child model that has no controller** (Note, Task, Brief). No
  `note.gen.ts`/`task.gen.ts`/`brief.gen.ts` is emitted (those files are only
  generated for models that HAVE a `*Controller`), so the module is missing.
- `{Model}Client` "incorrectly extends `ClientModel`" because generated `id` is
  `id?: number` (optional) while the base wants it required.
- `@model(...)` decorator + `static name = Attr.string(...)` trips
  `TS1238/TS1270` (the `name` static collides with `Function.name`).

**Why it still runs.** The dangling imports are **`import type`** — erased at
transpile time by Vite/esbuild, so they never hit runtime module resolution.
The `id?`/decorator issues are type-level only.

**This is pre-existing.** HEAD's committed `deal.gen.ts` already imports
`./note.gen` with no such file on disk, so `npm run typecheck` failed before any
of this work. Treat `tsc` as advisory for this demo; the source of truth for
"does it work" is the Vite runtime + the pre-flight boot script.

**Suggested upstream fix:** emit a lightweight `{child}.gen.ts` (just the
`{Child}Attrs` interface) for nested child models that lack a controller, or
inline the nested attrs type into the parent's `.gen.ts`. And generate
`id: number | null` on the client to match `ClientModel`.

---

## 4. `serverValidates: Validates.uniqueness()` doesn't satisfy the Attr type (cosmetic)

**Symptom.** `Company.model.ts`:
```
error TS2322: 'AsyncAttrValidator' is not assignable to type
'((val:any)=>Promise<string|null|undefined>) | (...)[] | undefined'
```
for the **documented** form `static slug = Attr.string({ serverValidates: Validates.uniqueness() })`.

**Runtime:** works — the pre-flight boot proves a duplicate slug is rejected
server-side and never runs in the browser. It's purely a `.d.ts` mismatch
between `AsyncAttrValidator` (which may return a sync `string`) and the
`serverValidates` field type (which expects a `Promise`).

**Mitigation:** left as the documented form (it's correct at runtime); noted
here as an upstream `.d.ts` fix (widen `serverValidates` to accept
`AsyncAttrValidator`).
