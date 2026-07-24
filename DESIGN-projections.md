# DESIGN — The Projection Tree (the one concept; supersedes all prior projection doctrine)

**Status:** target design, phased build plan at bottom. LLM-GUIDE §0.6
points here; no other document speaks for projections.

## The eternal problem, stated once

A controller serves a record graph. Four questions repeat at EVERY level
of that graph — the root, its notes, their sentiments:

1. which fields can be **seen**
2. which of those can be **edited**
3. which associations come **along**
4. …and recursively, 1–3 again inside each one

Today we answer them with four half-overlapping knobs (`expose`,
`permit`, `include`, nested-permit behavior) that only work at the top
level, are stringly-typed (a typo in `expose` is silent), and treat
included children as all-or-nothing rows. GraphQL solves only #1+#3
(reads) and gives up cache identity to do it. Rails strong params solve
only #2 (writes, via nested permit). Nobody unifies all four with types
and UI masks — we can, because we own every layer.

## The one concept — CEILING vs SHAPES (corrected 2026-07-20)

P1 fused two concerns into one `form:` tree: what may be edited/viewed
(SECURITY) and what gets loaded/sent (SHAPE). That fusion is why a second
shape looked like a mega-refactor — every shape would re-declare access
at every level. They are separate, and only one of them is recursive
about access:

**`@crud` = THE CEILING.** Access + the whole graph, declared ONCE.
`editable` implies viewable; a field in neither array does not exist on
this door; nested levels carry their own access.

```ts
@crud(Deal, {
  editable: ['name', 'amount', 'contactEmail'],
  viewable: ['stage', 'updatedAt'],
  include: {
    notes:   { editable: ['body'], viewable: ['position'],
               include: { sentiments: { editable: ['score'], viewable: ['label'] } } },
    company: { viewable: ['name'] },
  },
  index: { fields: ['name', 'stage'], include: { company: ['name'] }, sortable: [...] },
  get:   { /* omitted = the whole ceiling */ },
})
```

**Shapes = SUBSETS of the ceiling, never access.** `index` and `get` were
always the two built-in shapes (own routes, own cache families); named
ones are the same thing with a name:

```ts
@projection('card', { fields: ['name', 'amount'] })
@projection('feed', { fields: ['name'], include: { notes: ['body'] } })
```

Rules that make this safe and cheap:
- A shape may only REDUCE the ceiling (unknown field/assoc, or one the
  ceiling omits → compile error via generated types + regen error).
- A shape NEVER says editable/viewable. Editability is inherited from the
  ceiling, so it can never drift per-shape. `fields: [...]` +
  `include: { assoc: [...] | <subset> }` is the entire vocabulary.
- Each shape gets its OWN route and its own generated hook/handle
  (`useDealCard`), and its own cache family. Model-keyed coherence
  invalidates every shape of a model together — unchanged.
- **All writes go to ONE place**: the ceiling's write surface. Shapes are
  read concerns; there is exactly one form/validation/permit path per
  door regardless of how many shapes exist.

**What it subsumes:** `expose` = viewable ∪ editable; `permit` =
editable; `include` = the ceiling's include tree; nested write rules =
`editable` inside child ceiling nodes; `get.include`/`index.include` =
shape subsets. Per-record permit FUNCTIONS still narrow within the
ceiling at runtime.

## Type safety — the part that must be EXPLICIT

Two belts, both required:

1. **Generated config types.** Codegen emits, per model, into
   `@gen/models`:
   ```ts
   export interface LoanProjection {
     editable?: Array<'name' | 'amount' | 'stage' | …>
     viewable?: Array<'name' | 'amount' | 'stage' | …>
     include?: { notes?: NoteProjection; company?: CompanyProjection }
   }
   ```
   Controllers write `access: { … } satisfies LoanProjection` — a typo'd
   field or a non-existent association is a RED SQUIGGLE at the
   keystroke, recursively, at every level. (Same bootstrap story as the
   model type augmentations: first codegen run creates the types, regen
   keeps them true. Chicken-and-egg is already solved infrastructure.)
2. **Codegen validation** (for the non-editor path): unknown field /
   unknown association / view not ⊆ its parent ceiling → teaching error
   at regen. Contract probes grow the corresponding forge cases.

## What each view GENERATES (the client artifact)

```ts
import { useLoanForm, useLoanCard } from '@gen/controllers'
// form view → the full envelope form (today's useLoanEditForm, now
//   sliced per level: loan.notes children carry ONLY body+position,
//   position renders view-only, sentiments.score is the lone editable)
// card view → typed read hook + view-mode handle; its cache family is
//   (door, 'card'); ?view=card on the wire, allowlisted
```

Type-level guarantee at the call site: `<note.secret/>` doesn't compile
(the member doesn't exist in this view's handle), `<note.position edit/>`
is view-only at runtime AND its `edit` prop can be typed away. "Includes
safe": a view without `notes` has no `.notes` member — using it is a
compile error, not an undefined read.

## Wire + enforcement (every layer walks the same tree)

- **Serializer**: recursive slice — included children serialize ONLY
  their node's fields (ends "keep secrets out of included tables").
- **Envelope abilities**: tree-shaped —
  `abilities: { name: 'edit', notes: { body: 'edit', position: 'view', sentiments: {…} } }`;
  child FormSessions receive their own node (today they get null).
- **Write sanitize**: recursive — a nested payload field not marked
  `'edit'` at ITS level strips with the did-you-mean issue machinery.
  (This is Rails' nested strong-params, unified with the read side.)
- **Cache identity**: unchanged law — each (door, view) is a fixed,
  named shape with its own family; model-keyed coherence invalidates all
  of them together. Clients select views BY NAME; structural shape
  requests stay refused forever.
- **Coherence/channels multiplication (Daniel's worry, resolved):**
  INVALIDATION does not multiply — edges are model-keyed and prefix-
  invalidate every (door, view) family in one call, shape-count-blind.
  Only channels EMISSION multiplies (per (model, controller, view) blob)
  and the silence rule tames it at node level: a frame is
  `changedFields ∩ node.fields`, so a view whose slice carries none of
  the changed fields emits NOTHING. Narrow projections make the live
  system QUIETER: a field no view carries produces total silence where
  today it produces refetch traffic. Identical slices across views
  dedupe to one serialization (the get/index economy note, generalized).

## The refactor, sized honestly (NOT a big bang)

Compat rule: `expose`/`permit`/`include` DESUGAR into the access node —
every existing app keeps working untouched; new syntax opts into
narrowness.

- **P1 — BUILT, needs RESHAPING** (2026-07-20): ProjectionNode /
  normalizeProjection / sliceByProjection / @crud desugar / recursive
  read-slice at all three serialization sites / generated XProjection
  types all exist and WORK — but they were built around the fused
  `form:` tree (since renamed `access:`). The machinery is shape-mechanics and survives; what
  changes is WHO declares what: `form:` becomes the ceiling at @crud's
  top level (editable/viewable/include), and slicing is driven by a
  SHAPE subset resolved against it.
- **P2 — shapes: PARKED, do not build** (Daniel, 2026-07-20: "let's just
  not do shapes unless we have to"). `index`/`get` already differ in
  include today and that has been sufficient. Build ONLY when a real
  consumer needs a third shape on one door — and the ceiling is designed
  so it stays additive whenever that day comes.
- **P3 — the edit half**: tree-shaped abilities on the wire (from the
  CEILING), child sessions consuming their node, recursive write
  sanitize. Unchanged in substance from before; it reads the ceiling,
  not the shape.

## Refused, permanently

Structural client shape requests (field lists / include trees on the
wire). Escalation beyond the door's ceiling (`narrow` and views may only
reduce). Multiple write surfaces per door (the form node is the only
one).
