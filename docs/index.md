---
layout: home

hero:
  name: "ActiveDrizzle"
  text: "Rails-style ActiveRecord for Drizzle ORM"
  tagline: Full TypeScript codegen. Real associations. Zero boilerplate.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/danieth/active-drizzle

features:
  - icon: 🔷
    title: Drizzle-native
    details: Sits on top of Drizzle ORM. All your existing schemas and migrations work unchanged.
  - icon: ✨
    title: Full TypeScript codegen
    details: A Vite plugin generates typed .gen.d.ts files at build time — associations, scopes, enums, all type-safe.
  - icon: 🔗
    title: Real associations
    details: belongsTo, hasMany, hasOne, habtm — lazy-loaded or eager-loaded via includes(). No N+1 by default.
  - icon: 🎛️
    title: Attr transforms
    details: Declare get/set transforms, enums, JSON fields, date coercion, and virtual columns on the class.
  - icon: 🪝
    title: Lifecycle hooks
    details: beforeSave, afterCreate, afterCommit, @validate — with conditional execution and inheritance.
  - icon: 🏷️
    title: Single Table Inheritance
    details: Full STI support with automatic WHERE type = 'X' injection and correct subclass instantiation.
---
