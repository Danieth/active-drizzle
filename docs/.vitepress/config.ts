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
      { text: 'Controllers', link: '/controllers/overview' },
      { text: 'React Query', link: '/react/overview' },
      { text: 'Codegen & CLI', link: '/codegen/vite-plugin' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'The Happy Path', link: '/guide/happy-path' },
            { text: 'Installation & Boot', link: '/guide/installation' },
            { text: 'Project Structure', link: '/guide/project-structure' },
          ],
        },
      ],

      '/models/': [
        {
          text: 'Models',
          items: [
            { text: 'Overview', link: '/models/overview' },
            { text: 'Attributes & Enums', link: '/models/attributes' },
            { text: 'Associations', link: '/models/associations' },
            { text: 'STI', link: '/models/sti' },
            { text: 'Custom Primary Keys', link: '/models/custom-pk' },
          ],
        },
        {
          text: 'Querying',
          items: [
            { text: 'Basics', link: '/querying/basics' },
            { text: 'Scopes', link: '/querying/scopes' },
            { text: 'Aggregates & Counting', link: '/querying/aggregates' },
            { text: 'Pluck & Pick', link: '/querying/pluck' },
          ],
        },
        {
          text: 'Writing Data',
          items: [
            { text: 'Create, Update, Destroy', link: '/mutations/overview' },
            { text: 'Validations', link: '/hooks/validations' },
            { text: 'Transactions', link: '/mutations/transactions' },
            { text: 'Nested Attributes', link: '/mutations/nested-attributes' },
          ],
        },
        {
          text: 'Behavior',
          items: [
            { text: 'Lifecycle Callbacks', link: '/hooks/lifecycle' },
            { text: 'Dirty Tracking', link: '/hooks/dirty-tracking' },
          ],
        },
      ],

      // Legacy redirects — keep these sections accessible directly
      '/querying/': [
        {
          text: 'Querying',
          collapsed: false,
          items: [
            { text: '← Back to Models', link: '/models/overview' },
            { text: 'Basics', link: '/querying/basics' },
            { text: 'Scopes', link: '/querying/scopes' },
            { text: 'Aggregates & Counting', link: '/querying/aggregates' },
            { text: 'Pluck & Pick', link: '/querying/pluck' },
          ],
        },
      ],
      '/mutations/': [
        {
          text: 'Writing Data',
          collapsed: false,
          items: [
            { text: '← Back to Models', link: '/models/overview' },
            { text: 'Create, Update, Destroy', link: '/mutations/overview' },
            { text: 'Transactions', link: '/mutations/transactions' },
            { text: 'Nested Attributes', link: '/mutations/nested-attributes' },
          ],
        },
      ],
      '/hooks/': [
        {
          text: 'Behavior',
          collapsed: false,
          items: [
            { text: '← Back to Models', link: '/models/overview' },
            { text: 'Lifecycle Callbacks', link: '/hooks/lifecycle' },
            { text: 'Validations', link: '/hooks/validations' },
            { text: 'Dirty Tracking', link: '/hooks/dirty-tracking' },
          ],
        },
      ],

      '/controllers/': [
        {
          text: 'Controllers',
          items: [
            { text: 'Overview', link: '/controllers/overview' },
            { text: 'Routing & URL Structure', link: '/controllers/routing' },
            { text: 'CRUD Actions', link: '/controllers/crud-actions' },
            { text: 'Scopes & Permit', link: '/controllers/decorators' },
            { text: 'Custom Mutations', link: '/controllers/decorators#mutation' },
            { text: 'Actions & Endpoints', link: '/controllers/actions' },
            { text: 'Lifecycle Hooks', link: '/controllers/decorators#before-after' },
            { text: 'Error Handling', link: '/controllers/error-handling' },
          ],
        },
      ],

      '/react/': [
        {
          text: 'React Query',
          items: [
            { text: 'Overview', link: '/react/overview' },
            { text: 'ClientModel & Type Safety', link: '/react/client-model' },
            { text: 'Form Integration', link: '/react/forms' },
            { text: 'Error Handling', link: '/react/error-handling' },
          ],
        },
      ],

      '/codegen/': [
        {
          text: 'Codegen & CLI',
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
