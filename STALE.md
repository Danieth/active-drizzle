# STALE.md — out-of-date things, marked and tracked (not deleted)

> One row per item. Nothing here gets deleted until its row says so.
> When you resolve an item, move it to the Resolved section with a date.
> Last full audit: 2026-07-24.

## Legend

- **STALE** — contradicts current reality; the marker in the file says what to trust instead.
- **LEGACY** — still works, but superseded; do not build on it.
- **DORMANT** — unused by the current generation but has a plausible future role; decision deliberately open.
- **DELETE-CANDIDATE** — pure debris; delete whenever convenient (nothing references it).
- **PENDING** — not stale, but unfinished work parked in an odd place; tracked so it isn't mistaken for stale.
- **WATCH** — accurate today, scheduled to become stale when a planned design ships.

## Tracked items

| # | Item | Status | Marked in place? | What to do eventually |
|---|------|--------|------------------|----------------------|
| 1 | `a.out` (repo root) | DELETE-CANDIDATE | n/a (binary) | Compiled Mach-O object file, **committed to git**. `git rm` it and add `a.out` to `.gitignore`. |
| 2 | `packages/react/src/hooks.ts` | DORMANT (decision pending) | ✅ banner | Phase-4 hook factories (`createModelHook`/`createSearchHook`). The current react-generator emits nothing against them; only `index.ts` re-exports them. NOT deprecated — candidate future role as the lightweight read-only lane for presenter-side lookups (sessions are too heavy for "fetch options for a dropdown"). If revived: re-type against current generated meta and reconcile its `SearchState` with `IndexSession` so there's one list-state vocabulary. If presenters never need it, retire it then. |
| 3 | `REMAINING.md` test-count line ("258 tests") | STALE | ✅ warning block | Old snapshot; suite is far larger (README cites 900+). Recount and refresh the test-file table, or drop the count entirely. |
| 4 | `WEEKEND-2026-07-18.md` | STALE (historical) | ✅ archive banner | Sprint log, canonical only through 2026-07-19. Move to a `docs/history/` folder or leave archived — just never update it. |
| 5 | `packages/controller/packages/controller/tests/concerns/` | DELETE-CANDIDATE | n/a (empty dirs) | Accidental nested directory tree, zero files, not in git (git doesn't track empty dirs). `rmdir -p` it. |
| 6 | `readme-to-add-to-repo.md` | PENDING (not stale) | header already says so | 25 feature sections written as features landed, NOT yet folded into README.md (spot-checked: hasOne nested-forms section absent from README). This is queued writing work, not debris. |
| 7 | `LLM-GUIDE.md` §5 — signal-only SSE lane ("NEVER payloads") | WATCH | not yet | Accurate for shipped code today. DESIGN-ws-channels.md plans to replace this lane with payload-carrying channels; when that ships, §5 must be rewritten the same day or it becomes actively misleading. |

## Checked and NOT stale (so we don't re-flag them)

- `BEFORE_LAUNCH.md` encryption section — updated 2026-07-23 ("core BUILT, 69 tests"); current.
- `packages/trails/` — has both `bin/` and `package.json`; an earlier scan claimed the manifest was missing, which is no longer true (or never was).
- A rumored orphaned stub at `packages/core/packages/trails/` — does not exist; the only nested `packages/` dir is item 5.

## Resolved

*(nothing yet)*
