# DESIGN — Mutation Classification (green / yellow / red)

### Status: PROPOSED · 2026-08-27 · the classification lane the transport
### program deliberately deferred (DESIGN-transport-work §2: "transport
### ships with all mutations red"). Formal anchor: DESIGN-transport-proof
### T7 + obligation O13. Companion: DESIGN-live-view.md (the overlay the
### classification feeds composes at the view layer there). Code refs
### verified 2026-08-27 against the landed WS0–WS3 commits — re-grep
### before trusting a line number.

## 0. The three grades, defined by what the client may do

A mutation's grade is a **compile-time verdict per (door, mutation)** about
the echo, not a runtime mood:

- **RED — round-trip.** The client submits and waits. No optimistic render
  of the committed state; pending UI only. This is today's ONLY grade, on
  purpose: transport shipped all-red so that classification could be a
  separate lane with its own acceptance bar instead of a rider on WS0–WS3.
- **YELLOW — predictable but refusable.** The client can compute what the
  echo *would* be if the server says yes, but cannot prove the server will
  say yes. Render the prediction through T7's overlay, **marked pending**;
  a refusal (409/422/403) drops the intent and the overlay drains to σ.
- **GREEN — assume success.** The frontend may render the committed state
  immediately, unmarked. Licensed iff the compiler can prove the echo is a
  **pure function of client-held state**. Green never means "the server
  cannot refuse" (a CAS race still 409s — §4); it means "if the write
  lands, it lands exactly as predicted, and if it doesn't, the overlay
  drains" — assume, never lie forever.

The grade is monotone in evidence: every condition the compiler cannot
discharge demotes, and every demotion is a **teaching output** (§3), never
a silent downgrade.

## 1. The green certificate

Green is a certificate over the mutation's **write-set** (the door's
permitted fields plus the compiled write-effects of writing them). Four
conditions, each with its detector named. All four are per-door: the same
model can be green through one door and yellow through another.

1. **Every validator on the write-set is client-evaluable.** The two-lane
   validator taxonomy makes this ENUMERABLE, which is the entire reason it
   exists in this form
   (`packages/core/src/runtime/validators.ts:56-89` — the string lane plus
   the `.detailed` code lane; `application-record.ts:117-120` — the
   `serverValidate`/`serverValidates` async lane): the sync lane already
   runs in the browser (FormSession's client `validate()`,
   `packages/react/src/form-session.ts:444`), so a field whose validators
   are all sync-lane is client-decidable by construction. Demoters:
   - `Validates.uniqueness()` and anything else in `serverValidates`
     (validators.ts:365-382 — the `'taken'` failure is DB-backed and
     cannot be decided from client state; see landmine 1).
   - `@serverValidate` methods, categorically.
   - `@validate` instance methods whose read-set could not be proved —
     the extractor's `validationDeps` / `validationDepsError` machinery
     (`packages/core/src/codegen/types.ts:198-204`) already refuses
     unprovable deps; classification consumes the same verdict.
2. **No beforeSave/afterSave hooks outside the compiled write-effect
   graph.** The graph exists: `computeCoherenceEdges`
   (`packages/core/src/codegen/react-generator.ts:203`) composes
   writeSet(T) from the DECLARED effect edges — `touch`, `counterCache`,
   `dependent`, `acceptsNested`. A hook whose body writes anything not on
   those edges makes the echo depend on server-side computation the client
   cannot replay. Detector: the **hook-touches-undeclared-model nag**
   already committed to in DESIGN-wire-identity §4a (TCB, write-set
   completeness). HONEST STATUS: that nag is NOT landed — `HookMeta`
   today records decorator/condition/`on` only
   (`codegen/types.ts:185-190`), not body write-effects. Until the
   extractor carries hook write-sets, the conservative rule is mandatory:
   **any beforeSave/afterSave hook on a write-set model demotes the door**
   (condition-gated hooks whose condition field is outside the door's
   write-set may be exempted — the condition machinery is already
   validated against real columns, `codegen/validator.ts:244-260`).
   Green may not ship before this detector exists (landmine 2).
3. **No DB-generated echo values beyond the token — and the token IS now
   predictable.** WS0's CAS made the one unavoidable server-generated echo
   value a client-computable function: a successful write's token is
   exactly `loaded + 1`
   (`packages/core/src/runtime/application-record.ts:719-721` —
   `payload[lockCol] = loadedVersion + 1` under
   `WHERE lockCol = loadedVersion`). Everything else the DB generates —
   `updatedAt`, column defaults filled on create, autoSet stamps — is not
   a function of client state. The certificate therefore requires the
   door's echoed mask to contain no such field for the mutated lifecycle
   (`updatedAt` in the mask is the COMMON demoter; the fix is named in
   §3). Create-lane note: serial pks are server-generated too, so green
   creates additionally require a client-supplied-safe pk story or accept
   yellow — v1 scopes green to UPDATE mutations and says so.
4. **A STATIC permit for the written fields.** The permit must be the
   literal field list, not the function form — the compiler can enumerate
   a literal; a `(ctx, ctrl, record) => [...]` permit
   (`packages/controller/src/crud-handlers.ts:341,1447`) is opaque even
   when its body happens to be constant (landmine 4). Dynamic permits are
   not wrong — they demote, by construction (§2).

When all four hold, the compiled write-effect graph IS the echo
predictor: apply the write-set to held cells, stamp `loaded+1`, replay the
declared effect edges (touch bumps, counter deltas). O13 is the acceptance
bar making that sentence a theorem (§4).

## 2. Yellow by construction: dynamic permits

Settled 2026-08-27: **dynamic per-user/per-request permits are fully sound
for the transport algebra.** D remains a function `(user, door, record) →
field-slice` whether the mask is a literal or resolved per request; A3
totality, Rule M, and every T1–T9 statement are indifferent to how the
mask was computed. Nothing in the proof doc needs amending to admit them.

What they change is exactly one thing: **the client cannot evaluate the
rule**, so the echo is no longer a pure function of client-held state —
the server may narrow or refuse based on facts only it holds. That is the
definition of YELLOW: predictable-but-refusable. The client renders the
prediction through the overlay, marked pending; the abilities envelope it
already received (§5) is the best-effort hint, never a proof.

Yellow is therefore not a failure grade. It is the natural home of every
authorization rule with a viewer in it, and the classification output
should present it that way: "yellow: permit is per-user on this door —
that is correct placement; green would require moving the rule into the
model, which is wrong when the predicate mentions the user" (§5).

## 3. Classification is a teaching output

Codegen emits the verdict per (door, mutation) — and every demotion names
its cause AND its fix, in the taxonomy's own vocabulary (golden rule:
teaching errors). The shape:

```
yellow: uniqueness validator on `slug` (serverValidates → 'taken') —
        remove it from this door's write-set or accept the round-trip.
yellow: permit is dynamic on `door invoices#update` — correct if the rule
        mentions the user; if it only reads the record, move it to the
        model and the door goes green.
red:    beforeSave `syncLedger` writes `ledger_entries`, outside the
        compiled write-effect graph — declare the edge or keep red.
red:    `updatedAt` is in this door's echoed mask — drop it from the mask
        (display-only doors rarely need it) or accept the round-trip.
```

Two rules keep this honest:

- The verdict ships as data (a per-door table in the generated output),
  not only as build noise — DESIGN-live-view's overlay composition and
  the form runtime both branch on it.
- No override knob. A door is green because the certificate holds, never
  because the app asserted it. An `assumeGreen: true` escape hatch would
  convert every lemma downstream of T7 back into a hope (the closed-world
  premise, proof kernel).

## 4. 409 does not break green; O13 is the bar

A green mutation can still lose a CAS race: a concurrent writer advanced
the token, the write 409s (`StaleObjectError`,
`application-record.ts:727`). This is **compatible** with green because
green licenses *assuming*, not *lying forever*: the prediction lives in
T7's overlay (`composeEntity`, `packages/react/src/entity-store.ts:809`),
intents terminate in **echo-merge or drop**, and `compose(σ, ∅) = σ`. On
409 the intent drops, the overlay drains, σ still holds only certified
truth, and the form's existing 409/rehydrate story takes over — unchanged
(wire-identity §4a: the record-level lock is deliberately coarser).

The acceptance bar, stated as the proof doc states it (T7, O13):

> **O13.** For every green-classified (door, mutation): the composed
> prediction — write-set applied to held cells, token `loaded+1`,
> declared effect edges replayed — is EQUAL to the eventual echo, proven
> against the compiled write-effect graph. TCB-grade, beside write-set
> completeness (wire-identity §4a): the guarantee is exactly as strong as
> the graph is complete.

Nothing here is a consequence of Rule M — Rule M makes any echo *merge
soundly*; O13 is what makes the green prediction *be* the echo. That is
why it sits in the obligation register and not in §4 of the proof.

Acceptance tests, minimum: (a) property test per green door — random
held-state + mutation, prediction ≡ echo through the real handler on real
PG; (b) the 409 drain — prediction rendered, CAS loss injected, overlay
drains to pre-write σ with no residue; (c) a demotion test asserting the
classifier refuses each §1 condition's violation with the named message.

## 5. The layering rule (settled 2026-08-27, load-bearing for §1–§2)

Where a predicate lives is decided by what it mentions, not by where it
was first typed:

- **A predicate mentioning only the record (and its associations) belongs
  in the MODEL** — as a validator or an `Attr.state` transition guard
  (`packages/core/src/runtime/attr.ts:78-107`; transition legality is
  enforced in `validate()` on every save). It then holds for EVERY door
  and every write path, and — when it is sync-lane — it is
  client-evaluable for free, which is what makes green reachable at all.
- **A predicate mentioning the user belongs in the CONTROLLER permit.**
  Authorization is a property of the door; the model never takes a
  viewer. (The standing principle: model-level allowance is capability,
  not authorization — the model saying "this transition is legal" never
  authorizes this caller to make it; the door gates and the server
  enforces.) The dynamic permit form (§2) is the sanctioned home, and
  yellow is its honest grade.

**One-off predicate, never one-off plumbing.** The wire already carries
the verdict: `computeEnvelopeVerdicts`
(`packages/controller/src/crud-handlers.ts:337-378`) resolves the
record-aware permit into the `abilities` / `can` / `why` maps on every
envelope, and enforcement is `buildPermittedData`
(`crud-handlers.ts:1118-1150`) on every write. A new per-user rule is one
predicate in the permit function — it must never grow a bespoke endpoint,
a client-side mirror of the rule, or a second verdict channel. The client
renders what the envelope said and lets the server refuse; that is the
whole yellow contract.

Misplacement detector (teaching output, both directions): a permit
function whose body never reads `ctx`/user demotes a door that could be
green — "this rule reads only the record; move it into the model." A
model validator reaching for a viewer has no lane to do it with — the
taxonomy simply has no user parameter, which is the point.

## 6. Non-claims

- **Not invariant confluence in general.** The literature's bar (can this
  operation commute with concurrent operations?) is neither necessary nor
  sufficient here; green is a narrower, compiler-provable statement about
  echo predictability under this repo's write path. Do not cite green as
  a confluence result.
- **No cross-record green.** A2 is per-record; a green verdict never
  spans a multi-model envelope. Nested writes demote in v1.
- **No green destroys or creates in v1.** Destroy echoes are predictable
  (D = lock + 1, WS2) but ride cascade hooks and membership effects;
  creates echo server pks and defaults. Scoped out, stated, revisitable.
- **No offline queue.** Green licenses immediate rendering of a
  prediction for an in-flight RPC on 𝒞r — not queuing writes for later.
  Different peak (proof kernel: a different algebra is a different peak,
  not a larger version of this one).
- **No client-side enforcement claim.** Client-evaluable validators are a
  prediction aid; the server re-runs everything. Nothing in this lane
  moves enforcement off the server.

## 7. Landmines

1. **Shortcutting 'taken' client-side.** A local uniqueness check over
   held rows is a race with a bow on it — the client's view is a
   projection of a moving database. Uniqueness demotes; it never gets a
   client approximation that upgrades.
2. **Shipping green before the hook detector.** With HookMeta blind to
   body write-effects, a green verdict is a bet that no hook does
   anything — exactly the "invisible stale related row" the TCB section
   warns about. The conservative any-hook-demotes rule is mandatory until
   the nag lands.
3. **Token prediction outside the CAS.** `loaded+1` is a theorem of the
   save()/destroy() CAS path only. `updateAll` bumps in-statement without
   a loaded baseline, and out-of-contract writes (raw SQL) bump nothing —
   any door whose mutation path is not the CAS write path demotes.
4. **"Constant" permit functions.** The compiler classifies the FORM, not
   the evaluation: a function permit demotes even when its body is a
   literal return. The fix is the static form — one line, named in the
   teaching output. Purity analysis of permit bodies is deliberately not
   attempted.
5. **Grade drift across deploys.** A door's grade can change when a
   validator or hook is added — a client built against green composing
   unmarked predictions while the new server refuses is the skew case.
   The grade must ride the generated door module (same artifact, same
   deploy) — never be fetched, cached, or assumed cross-version.

## 8. Relation to the other documents

- **DESIGN-transport-proof.md** — T7 (the overlay this lane feeds), O13
  (the bar), A2/A3 (why per-record, why per-door), the kernel's
  closed-world premise (why no override knob).
- **DESIGN-transport-work.md** — §2 "Rows offline / green-yellow-red"
  (the deliberate all-red shipping decision this doc now discharges the
  design half of); WS0's O2 (the CAS that made tokens predictable).
- **DESIGN-wire-identity.md** — §4a TCB (write-set completeness, the
  hook nag), P4 (the server never makes the client guess — the echo
  contract green predicts against).
- **DESIGN-live-view.md** — where yellow/green predictions surface:
  overlay composition at the view layer, never in derived-state inputs.
