# Architecture

The big picture. Each layer is a **projection** of the one below — usable everywhere, with different shapes for different contexts.

---

## DB / Drizzle — Ground Zero

The schema is the absolute foundation. Drizzle tables, columns, types, constraints. Nothing above it exists without this. Migrations, indexes, FKs — it's all here. Everything else is a projection.

---

## Model — The Projection Layer

The Model layer sits on top of the schema. It's a **projection** — usable everywhere in your app: server, background jobs, scripts, and (in a stripped-down form) the frontend.

**Attr is huge.** It's the implicit transform layer. Enums, get/set coercion, JSON, dates, virtuals — all declared once, applied everywhere. You don't write `status === 1`; you write `statusIsDraft()` or `status === 'draft'`. The transform is implicit.

Add custom instance methods. Add validations (`@validate`, `serverValidate`). The Model is where behavior lives. It's the single place you define "what a Campaign is" — and that definition flows to every layer that touches it.

The frontend version is stripped down: no server-only methods, no DB. But it still has the enum predicates, the validations, the shape. Same model, lighter projection.

---

## Controller — Auth, Nesting, Routing

Your primary concerns here: **auth**, **nesting** (scopes, paramScopes), and **routing**. When you want to surface a model, it's painless — `@crud` and you're done.

But the Controller layer is not just "model over HTTP." Add a route backed by ElasticSearch. Kick off a background job. Call an external API. Plain controllers (no CRUD) handle uploads, invites, webhooks. `@before` and `@after` hooks let you inject custom logic — rate limits, logging, side effects. The controller is the **HTTP boundary** — and you can make it do whatever that boundary needs.

---

## Frontend — Projection of a Projection

The generated hooks are a **projection of the Model projection**. Two controllers that use the same model can expose different shapes: different `include`s, different `permit` lists, different scopes. Each controller produces its own typed client — a unique projection.

On the frontend, you still get instance methods (`statusIsDraft()`), enum predicates, type safety. Everything that made it through the controller's config is there. But it's an **extremely unique** projection — shaped by which controller, which scopes, which includes. The same Campaign model might look different from `CampaignController` vs `AdminCampaignController`. Same source, different views.

---

## The Stack

```
DB (Drizzle)     → ground zero
     ↓
Model (Attr, methods, validations) → projection, usable everywhere
     ↓
Controller (auth, nesting, routing, custom routes) → HTTP boundary
     ↓
Generated Client → projection of the projection, per controller
     ↓
React (.use / .with) → typed hooks, unique per controller
```
