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

## The one concept

```ts
type Access = 'edit' | 'view'

interface ProjectionNode {
  /** Slice + editability in ONE map. Absent field = does not exist here. */
  fields: Record<string, Access>
  /** Recursive: each included association is itself a sliced node. */
  include?: Record<string, ProjectionNode>
  /** Optional record/ctx-aware NARROWING (may only downgrade/remove). */
  narrow?: (ctx, record) => Partial<Record<string, Access | null>>
}
```

A controller declares one **canonical form node** (the envelope + the
write surface) and optionally named **read views** (reductions):

```ts
@crud(Loan, {
  form: {
    fields: { name: 'edit', amount: 'edit', stage: 'view' },
    include: {
      notes: {
        fields: { body: 'edit', position: 'view' },
        include: {
          sentiments: { fields: { label: 'view', score: 'edit' } },   // Daniel's slice:
        },                                                            // see 2 fields, edit 1
      },
    },
  },
  views: {
    card: { fields: { name: 'view', amount: 'view' } },   // read-only reductions
  },
  index: { /* unchanged; its row shape is just another view */ },
})
```

**What it subsumes** (these become sugar that desugars into the tree):
`expose` = keys of `fields`; `permit` = keys marked `'edit'`; `include` =
the include tree (legacy form = node with all fields, plus a codegen
nudge toward slicing); nested write rules = `'edit'` marks inside child
nodes; per-record permit fns = `narrow`.

## Type safety — the part that must be EXPLICIT

Two belts, both required:

1. **Generated config types.** Codegen emits, per model, into
   `@gen/models`:
   ```ts
   export interface LoanProjection {
     fields: Partial<Record<'name' | 'amount' | 'stage' | …, Access>>
     include?: { notes?: NoteProjection; company?: CompanyProjection }
   }
   ```
   Controllers write `form: { … } satisfies LoanProjection` — a typo'd
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

## The refactor, sized honestly (NOT a big bang)

Compat rule: `expose`/`permit`/`include` DESUGAR into the form node —
every existing app keeps working untouched; new syntax opts into
narrowness.

- **P1 — types + read slices** (the eternal problem's read half):
  generated `XProjection` types + codegen validation (kills silent
  typos); recursive slice serialization; envelope carries sliced
  children. Runtime: serializer + envelope builder. Medium.
- **P2 — the edit half**: tree-shaped abilities on the wire; child
  sessions consume their node; recursive write sanitize. Runtime:
  sanitizer + react session/handle plumbing (seats already exist).
  Medium-large.
- **P3 — named views + artifacts**: `?view=` param, per-view cache
  families + generated hooks/handles. Codegen-heavy, runtime-light.
- Each phase ships alone; nothing breaks between phases.

## Refused, permanently

Structural client shape requests (field lists / include trees on the
wire). Escalation beyond the door's ceiling (`narrow` and views may only
reduce). Multiple write surfaces per door (the form node is the only
one).
