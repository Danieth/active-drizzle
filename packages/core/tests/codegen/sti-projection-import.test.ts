/**
 * Co-located STI + Projection type imports — the combined runtime module for
 * a shared source file must never import its OWN Projection interface.
 *
 * A co-located STI subclass whose association resolves back to the co-located
 * base (`class Subtask extends Task { static parent = belongsTo({ table:
 * 'tasks' }) }` — the ordinary self-referential tree layout the STI guard
 * endorses) made generateClientRuntime emit
 * `import type { TaskProjection } from './Task.model.gen.js'` INSIDE
 * Task.model.gen.ts, which also declares `export interface TaskProjection`
 * — TS2440 "Import declaration conflicts with local declaration" in
 * generated code. The filter compared class names only; it must compare
 * OUTPUT FILES.
 */
import { describe, it, expect } from 'vitest'
import { createTestProject } from '../helpers/index.js'
import { extractModels } from '../../src/codegen/extractor.js'
import { generate } from '../../src/codegen/generator.js'

const schema = `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
export const tasks = pgTable('tasks', {
  id: integer('id').primaryKey().notNull(),
  parentId: integer('parent_id'),
  type: text('type'),
})
export const comments = pgTable('comments', {
  id: integer('id').primaryKey().notNull(),
  taskId: integer('task_id').notNull(),
  body: text('body'),
})`

const TASK_MODEL = `import { ApplicationRecord, model, belongsTo } from 'active-drizzle'
@model('tasks')
export class Task extends ApplicationRecord { static stiType = 'Task' }
@model('tasks')
export class Subtask extends Task {
  static stiType = 'Subtask'
  static parent = belongsTo('tasks', { foreignKey: 'parentId' })
}`

const COMMENT_MODEL = `import { ApplicationRecord, model, belongsTo } from 'active-drizzle'
@model('comments')
export class Comment extends ApplicationRecord {
  static task = belongsTo('tasks', { foreignKey: 'taskId' })
}`

function generateAll() {
  const project = createTestProject({
    schema,
    models: { 'Task.model.ts': TASK_MODEL, 'Comment.model.ts': COMMENT_MODEL },
  })
  const models = [
    ...extractModels(project.tsProject, '/project/models/Task.model.ts'),
    ...extractModels(project.tsProject, '/project/models/Comment.model.ts'),
  ]
  return generate({ schema: project.extractSchema(), models })
}

describe('co-located STI runtime: Projection import targeting', () => {
  it('does NOT import its own Projection from itself (was TS2440)', () => {
    const files = generateAll()
    const task = files.find(f => f.path === 'Task.model.gen.ts')!.content

    // the interface is declared locally…
    expect(task).toContain('export interface TaskProjection')
    // …so the combined module must not ALSO import it from its own file
    expect(task).not.toContain("import type { TaskProjection } from './Task.model.gen.js'")
    // the subclass's include still references the in-file interface
    expect(task).toContain('parent?: TaskProjection')
  })

  it('still imports a Projection that lives in a DIFFERENT output file', () => {
    const files = generateAll()
    const comment = files.find(f => f.path === 'Comment.model.gen.ts')!.content
    expect(comment).toContain("import type { TaskProjection } from './Task.model.gen.js'")
    expect(comment).toContain('task?: TaskProjection')
  })
})
