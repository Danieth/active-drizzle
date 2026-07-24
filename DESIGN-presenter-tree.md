# DESIGN — The Presenter Tree (spec; supersedes all prior presenter-layout doctrine)

**Status:** SPEC — approved direction, build next. The demo's hand-built
tree (`active-drizzle-demo/src/presenters/`) is the REFERENCE
IMPLEMENTATION; its `index.ts` header says what this spec automates.
Golden-rule clauses in force: generate-then-keep, one fact one place,
errors at the earliest possible moment, sockets never vocabulary.

## 0. The one sentence

A command generates the presenter tree; regen keeps it complete and
verifies its three laws; boot re-verifies from the generated manifest;
nobody ever imports a presenter, hand-maintains a registry, or ships an
Attr without a bulb — and every violation is a teaching error naming the
file and the fix.

## 1. The tree (canonical layout, root-level `presenters/`)

```
presenters/
  context.ts              ← app-wide client ctx + the APP LAYOUT declaration
  attr/<kind>/index.tsx   ← THE BULBS: one folder per kind IN USE
  attr/<kind>/context.ts  ← optional kind-area ctx/layout
  models/<Model>/form.tsx ← whole-record form composition (later phase)
  models/<Model>/show.tsx ← index-row presentation (later phase)
  models/<Model>/context.ts
  controllers/<Ctrl>/…    ← per-door OVERRIDES (Rails view-resolution ladder)
  controllers/<Ctrl>/<Nested>/…  ← NESTED doors mirror @scope nesting:
                             /teams/:teamId/deals → controllers/Teams/Deals/
                             (resolution walks OUTWARD: most-nested dir →
                             parent door dir → models/<Model>/ → scaffold)
  .gen/                   ← the generated registry (never edited):
     _registry.gen.tsx    ← imports/registers EVERYTHING, area wrapping,
     _pctx.gen.tsx        ← context providers (already built)
     _manifest.gen.json   ← coverage manifest (boot verification input)
     _types.gen.ts        ← AdPresenterKinds + AdKindShapes augmentations
```

No `web/`. `presenters/` is a first-class sibling of `server/` —
`app/views` energy. The vite plugin takes `presenters: 'presenters'`
(configurable mount, one blessed default).

## 2. The command — `trails presenters` (also runs inside `trails init` and every regen)

**Generate-then-keep, never overwrite.** For every kind any model uses:
if `presenters/attr/<kind>/index.tsx` is missing, GENERATE a working,
ugly, commented bulb (`// SCAFFOLD — yours now, style it`) registering
edit+view under `PresenterPropsFor<'<kind>'>` typing. Existing files are
never touched. Same for: root `context.ts` (commented example + the
default layout slot), `models/<Model>/` stubs when asked
(`trails presenters --models`), and the `.gen/` outputs (always
regenerated, always gitignored).

The command prints a REPORT, every run:

```
presenters ✓ 14 kinds covered (2 generated this run: bps, timezone)
layouts    ✓ chrome coverage complete (errors→ShellLayout, dirty→ShellLayout, …)
context    ✓ 4 areas, no shadows, no server-lane collisions
```

## 3. The three laws (all regen-enforced, all teaching errors)

**LAW 1 — presenter coverage: every Attr has a presenter, ALWAYS.**
Every kind in use must resolve an edit AND a view presenter (view-only
kinds may declare `editable: false` in the kind's registration to waive
edit). Satisfied BY CONSTRUCTION (regen generates missing folders). The
error exists only for humans breaking it afterward:
> `presenters/attr/money/ was deleted but Deal.amount (server/models/
> Deal.model.ts) is kind 'money' — restore the folder or run
> \`trails presenters\` to regenerate the scaffold.`
Per-Attr overrides (`presenters:` on the Attr) must name registered
presenters whose kind matches — same error family, at regen not render.

**LAW 2 — no-shadow context (BUILT).** A nested folder redeclaring an
ancestor's context key, or any client key colliding with a server
`@frontendContext` key, fails regen naming both files ("one fact, one
lane"). Siblings may reuse keys.

**LAW 3 — chrome coverage: every responsibility handled somewhere,
NOTHING handled nowhere.** Layouts are CONTEXT (not registration):
declared in a folder's `context.ts` beside the keys —
```ts
export default definePresenterContext({ density: () => … }, {
  layout: ShellLayout,
  consumes: ['label', 'errors', 'dirty', 'help'],
})
```
Layers stack down the tree; each declares what it CONSUMES; the bulb
receives the REMAINDER. The REQUIRED set (`label`, `errors`, `dirty`,
`state`, `elsewhere`) must be covered on EVERY path: consumed by an
enclosing layout, or declared handled by the bulb
(`handles: ['state']` in its registration). A responsibility handled
nowhere on some path:
> `under presenters/models/Deal/, nothing handles 'dirty' — consume it
> in a layout (presenters/context.ts) or declare handles: ['dirty'] on
> the bulb.`
Double-consumption on one path is the same error inverted (two layers
claiming 'errors' = two error lists rendered). `layout: false` on a bulb
opts out of wrapping but NOT out of the coverage law — a bare bulb must
`handles:` the full required set.
The transitional `registerPresenterLayout` API is DELETED in this phase
(pre-1.0, no compat); the runtime stacking provider underneath survives
as the mechanism the generated registry drives.

## 4. The generated registry (`_registry.gen.tsx`) — deletes the demo's `index.ts`

Scans the tree; emits: imports of every bulb/layout/context module;
`registerPresenter` calls with kind + per-kind defaults derived from
folder placement (the `attr/money/` folder IS the money default — no
`setDefaultPresenters` hand-list); AREA WRAPPING (each folder's
presenters wrapped in that folder's context+layout providers — the
folder placement IS the scoping, no per-page provider mounting);
`AdPresenterKinds` + `AdKindShapes` augmentations emitted from the same
scan (kills the hand-maintained d.ts and its drift — one fact: the
folder). The app's entry imports `@gen/presenters` once; `trails doctor`
checks that line.

## 5. Boot verification (the "on boot" demand)

Regen writes `_manifest.gen.json`: kinds in use → presenters registered,
required-set coverage per area, context key map. At server AND client
boot, a fast manifest check (no scanning) re-verifies: every kind
covered, registry import present, manifest fresh vs model set. Stale or
violated → boot fails with the regen command in the message. This
catches the running-without-regen / deleted-files-after-regen window
that regen-time checks can't see.

## 6. Typing (all compile-time, all automatic)

- Bulbs: `PresenterPropsFor<'<kind>'>` (BUILT) — value typed by kind;
  registry emits `AdKindShapes` entries for app-defined kinds when
  `defineAttrKind` lands.
- Call sites: `AdPresenterKinds` emitted → `<deal.amount edit="tagsInput"/>`
  is a compile error listing legal presenters (gate exists; emission
  makes it automatic).
- Ctx: per-area types (BUILT for root; area-grain rides the registry).
- Chrome: `handles:`/`consumes:` are typed against the required-set
  union — a typo'd responsibility name is a red squiggle.

## 7. Acceptance criteria (executable)

1. `trails presenters` on the DEMO generates a registry that makes
   `src/presenters/index.ts` DELETABLE with byte-identical behavior
   (the demo session verifies; their `_pctxtest.mts` extends to the
   registry).
2. Fresh `trails new` app: zero hand-registration, all kinds covered by
   scaffolds, boot check green, every law's error reachable by breaking
   it (test per error).
3. Canary: an LLM given only the scaffolded app completes "add a field
   with a custom presenter, admin-visible only" without touching
   `node_modules` or writing an import for any presenter.

## 8. Build order

1. Kind-scaffold generation + LAW 1 + report (the command core).
2. `_registry.gen.tsx` + folder-derived defaults + area wrapping + typed
   emissions; delete `registerPresenterLayout` API + demo `index.ts`.
3. LAW 3 (consumes/handles + coverage walk) — replaces today's
   def-level `layout:` key.
4. Boot manifest verification.
5. `models/<Model>/{form,show}` + controller-override ladder + covers/
   omits manifests (its own slice; this spec reserves the folder shape).

## 9. Refinements (Daniel, 2026-07-25)

- **Variants are first-class**: a kind folder exports MANY named bulbs;
  the scan registers all; AdPresenterKinds types every name. Area
  context.ts may declare `defaults: { money: 'compact' }` — AREA-SCOPED
  kind defaults: same field, full in a form, compact on a Board card,
  zero call-site noise.
- **Attr-level context** = the `meta:` bag (already flows Attr →
  fieldMeta → props.meta), upgraded: typed per kind via
  AdKindShapes['meta'].
- **Forms make the leap NOW**: form.tsx/show.tsx + the controller
  ladder (incl. nested dirs above) are IN this phase, ceiling-validated
  with covers/omits. Slice 5 is promoted; the tree is the whole view
  layer.
- **Auto-generation is the key** (restated): every dir in the ladder is
  scaffoldable on demand (`trails presenters --controller Teams/Deals`),
  generated-then-kept, and the registry derives everything from
  placement. Nothing is registered by hand, ever.

## 10. The free superpowers (fall out of the machinery)

1. **Living catalog** (`/_presenters` dev route): every bulb × every
   state (dirty/saving/conflict/elsewhere/waiting) from REAL sessions
   (the testing kit) — Storybook with zero config that CANNOT drift.
2. **Render coverage in CI**: headless-mount every form of every model;
   assert zero boundary chips — the whole UI provably renders.
3. **Field inspector** (dev overlay): which bulb, which layout consumed
   what, which area, which ctx keys — from the registry + manifest.

The pitch: everyone else CATALOGS their UI and hopes; this framework
DERIVES its UI and proves it. The schema proves the UI complete.
