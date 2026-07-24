# THE GOLDEN RULE

> We maximize leverage. Most dry code possible, can be written, in a
> single place — with — the greatest possible, developer experience.
> Errors / inconsistencies / bad choices are shown, when anything is
> wrong, to the code writer — and communicated well. Where we can, we
> stick to what Rails does. When we don't, we are doing the things Rails
> wishes it could.

Every feature passes this filter or dies. Corollaries earned this far:

- The framework ships SOCKETS, never vocabulary — apps define their own
  kinds, presenters, context keys.
- The compiler GENERATES missing required files (scaffold, kept, never
  overwritten); it errors only when a human breaks the invariant after.
- One fact, one place: keys never shadow, pipelines never fork, a second
  weaker copy of anything is a bug by definition.
- Model types are law on every wire (the serialization-fidelity law).
- Instant-and-wrong loses to one-beat-late-and-correct (membership is
  never guessed); values may be optimistic because they are DECLARED.
- Signals live at the grain of the thing that renders them: presenters
  are fields, so narration (dirty/state/elsewhere/tick) is per-field.
- Formatting is APP vocabulary: the framework never ships format/parse
  for values (no Intl, no repr codecs) — the app dries that up itself.
- Chrome is written ONCE, by the app, as a LAYOUT: bulbs are value+bind;
  the layout renders label/errors/dirty/state around them.
- LAYOUTS ARE CONTEXT (Daniel, 2026-07-24): chrome declares itself in
  folder context.ts and wraps everything beside/below; each layer
  CONSUMES named responsibilities (errors, dirty, …); the bulb receives
  the REMAINDER; regen errors when a required responsibility is handled
  NOWHERE on a path. Per-presenter layout registration is transitional
  and dies in the tree phase.
