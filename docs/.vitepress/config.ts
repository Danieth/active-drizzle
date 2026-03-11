import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ActiveDrizzle',
  description: 'Rails-style ActiveRecord for Drizzle ORM — with full TypeScript codegen',
  base: '/active-drizzle/',

  head: [
    ['link', { rel: 'icon', href: '/active-drizzle/favicon.svg', type: 'image/svg+xml' }],
  ],

  themeConfig: {
    logo: { src: '/logo.svg', alt: 'ActiveDrizzle' },
    siteTitle: 'ActiveDrizzle',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Models', link: '/models/overview' },
      { text: 'Querying', link: '/querying/basics' },
      { text: 'Mutations', link: '/mutations/overview' },
      { text: 'Hooks', link: '/hooks/lifecycle' },
      { text: 'Codegen & CLI', link: '/codegen/vite-plugin' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Installation & Boot', link: '/guide/installation' },
            { text: 'Project Structure', link: '/guide/project-structure' },
          ],
        },
      ],
      '/models/': [
        {
          text: 'Models',
          items: [
            { text: 'Defining Models', link: '/models/overview' },
            { text: 'Attributes (Attr)', link: '/models/attributes' },
            { text: 'Associations', link: '/models/associations' },
            { text: 'Single Table Inheritance', link: '/models/sti' },
            { text: 'Custom Primary Keys', link: '/models/custom-pk' },
          ],
        },
      ],
      '/querying/': [
        {
          text: 'Querying',
          items: [
            { text: 'Basics', link: '/querying/basics' },
            { text: 'Aggregates & Counting', link: '/querying/aggregates' },
            { text: 'Scopes', link: '/querying/scopes' },
            { text: 'Pluck & Pick', link: '/querying/pluck' },
          ],
        },
      ],
      '/mutations/': [
        {
          text: 'Mutations',
          items: [
            { text: 'Create, Update, Destroy', link: '/mutations/overview' },
            { text: 'Nested Attributes', link: '/mutations/nested-attributes' },
            { text: 'Transactions', link: '/mutations/transactions' },
          ],
        },
      ],
      '/hooks/': [
        {
          text: 'Hooks',
          items: [
            { text: 'Lifecycle Hooks', link: '/hooks/lifecycle' },
            { text: 'Validations', link: '/hooks/validations' },
            { text: 'Dirty Tracking', link: '/hooks/dirty-tracking' },
          ],
        },
      ],
      '/codegen/': [
        {
          text: 'Codegen',
          items: [
            { text: 'Vite Plugin & CLI', link: '/codegen/vite-plugin' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/danieth/active-drizzle' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 Daniel Ackerman',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/danieth/active-drizzle/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
})
