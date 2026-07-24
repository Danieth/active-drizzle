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
