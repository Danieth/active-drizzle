/**
 * React-generator escaping — app-controlled state/event/enum strings must
 * become VALID string literals in the generated controller module.
 *
 * The escaping burn-down routed generator.ts (core) literals through
 * jsString, but react-generator.ts still interpolated the same strings raw
 * at its twin sites: the can() event comparison, the stateMeta block
 * (event/from/to/state labels), and the enum/state predicate RHS. An
 * apostrophe-bearing transition name (`won't-fix` — an ordinary object key
 * the extractor un-quotes) produced a SyntaxError that broke the WHOLE
 * generated .gen.ts module, while the identical model compiled fine through
 * the fixed core generator.
 *
 * NOTE the deliberately narrower scope for enum/state LABELS: a label also
 * lands in an IDENTIFIER position (`statusIsWon't()`), which jsString cannot
 * fix — that identifier-sanitization question spans the core generator and
 * the runtime proxy and is tracked separately. These tests pin the
 * string-literal half only.
 */
import { describe, it, expect } from 'vitest'
import { ts } from 'ts-morph'
import { createTestProject } from '../helpers/index.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlMeta, CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

const ticketsSchema = `
import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'

export const tickets = pgTable('tickets', {
  id: serial('id').primaryKey(),
  status: integer('status'),
  kind: integer('kind'),
  title: text('title'),
})
`

function makeCtrl(): CtrlMeta {
  return {
    filePath: '/src/Ticket.ctrl.ts',
    className: 'TicketController',
    basePath: '/tickets',
    scopes: [],
    kind: 'crud',
    modelClass: 'Ticket',
    mutations: [],
    actions: [],
    crudConfig: {
      index: {},
      // abilities + expose turn on the envelope (form hooks + index surface),
      // which is where the stateMeta block is emitted
      get: { expose: ['id', 'title', 'status', 'kind'], abilities: true },
      create: { permit: ['title', 'status', 'kind'] },
      update: { permit: ['title', 'status', 'kind'] },
    },
  } as CtrlMeta
}

function generateFor(modelSource: string): string {
  const project = createTestProject({
    schema: ticketsSchema,
    models: { 'Ticket.model.ts': modelSource },
  })
  const projectMeta: ProjectMeta = {
    schema: project.extractSchema(),
    models: [project.extractModel('Ticket.model.ts')],
  }
  const ctrlProject: CtrlProjectMeta = { controllers: [makeCtrl()] }
  const files = generateReactHooks(ctrlProject, projectMeta, '/out')
  return files.find(f => f.filePath.toLowerCase().includes('ticket'))!.content
}

/** Syntactic (parse-level) diagnostics for a generated module. */
function parseErrors(code: string): string[] {
  const sf = ts.createSourceFile('gen.ts', code, ts.ScriptTarget.Latest, true)
  return ((sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [])
    .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
}

describe('react-generator: apostrophe-bearing transition EVENT', () => {
  // `transitions: { "won't-fix": … }` — the extractor strips the quotes, so
  // the event name reaching the generator is `won't-fix`.
  const model = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

@model('tickets')
export class Ticket extends ApplicationRecord {
  static status = Attr.state({
    states: { open: 0, closed: 1 } as const,
    initial: 'open',
    transitions: {
      "won't-fix": { from: ['open'], to: 'closed' },
    },
  })
}
`

  it('generates a syntactically VALID controller module end-to-end', () => {
    const content = generateFor(model)
    expect(parseErrors(content)).toEqual([])
  })

  it('escapes the event in can() (twin of the fixed generator.ts site)', () => {
    const content = generateFor(model)
    expect(content).toContain("if (event === 'won\\'t-fix')")
    expect(content).not.toContain("if (event === 'won't-fix')")
  })

  it('escapes the event in the index-surface stateMeta', () => {
    const content = generateFor(model)
    expect(content).toContain("event: 'won\\'t-fix'")
    expect(content).not.toContain("event: 'won't-fix'")
  })
})

describe('react-generator: apostrophe-bearing enum/state LABELS (literal half)', () => {
  const model = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

@model('tickets')
export class Ticket extends ApplicationRecord {
  static kind = Attr.enum({ "it's": 0, plain: 1 } as const)
  static status = Attr.state({
    states: { "won't": 0, done: 1 } as const,
    initial: "won't",
    transitions: {
      give: { from: ["won't"], to: 'done' },
    },
  })
}
`

  it('escapes the enum predicate RHS comparison', () => {
    const content = generateFor(model)
    expect(content).toContain("this.kind === 'it\\'s'")
    expect(content).not.toContain("this.kind === 'it's'")
  })

  it('escapes the state predicate RHS comparison', () => {
    const content = generateFor(model)
    expect(content).toContain("this.status === 'won\\'t'")
    expect(content).not.toContain("this.status === 'won't'")
  })

  it('escapes state labels and to-labels in stateMeta', () => {
    const content = generateFor(model)
    // states: […] carries the escaped label
    expect(content).toContain("states: ['won\\'t', 'done']")
    // the transition's from-array carries it too, and `to` stays a clean literal
    expect(content).toContain("from: ['won\\'t'], to: 'done'")
  })
})
