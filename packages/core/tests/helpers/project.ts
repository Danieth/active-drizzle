/**
 * createTestProject — the core test helper for codegen tests.
 *
 * Sets up an in-memory ts-morph Project, writes schema + model source
 * files into it, and returns a handle you can use to run codegen stages
 * and inspect the results.
 *
 * The in-memory FS means:
 *   - No temp directories to clean up
 *   - No disk I/O (fast)
 *   - ts-morph resolves types correctly (it uses the TS compiler internally)
 *
 * Usage:
 *
 *   const project = createTestProject({
 *     schema: schemas.assetsAndBusinesses,
 *     models: {
 *       'Asset.model.ts': modelBuilder('Asset', 'assets')
 *         .belongsTo('business')
 *         .hasMany('campaigns')
 *         .build(),
 *     },
 *   })
 *
 *   // Test extraction:
 *   const schemaMeta = project.extractSchema()
 *   expect(schemaMeta.tables['assets'].columns).toHaveLength(5)
 *
 *   // Test model extraction:
 *   const assetMeta = project.extractModel('Asset.model.ts')
 *   expect(assetMeta.associations).toHaveLength(2)
 *
 *   // Test validation:
 *   const diagnostics = project.validate()
 *   expect(diagnostics).toHaveLength(0)
 *
 *   // Test generation:
 *   const files = project.generate()
 *   expect(files['Asset.model.gen.d.ts']).toContain('business: Promise<BusinessRecord>')
 *
 *   // Or do it all at once and inspect the results:
 *   const result = project.run()
 *   expect(result.errors).toHaveLength(0)
 *   expect(result.files['Asset.model.gen.d.ts']).toMatchSnapshot()
 */

import { Project } from 'ts-morph'
import { extractSchema, extractModel } from '../../src/codegen/extractor.js'
import { validate } from '../../src/codegen/validator.js'
import { generate } from '../../src/codegen/generator.js'
import type {
  Diagnostic,
  GeneratedFile,
  ModelMeta,
  ProjectMeta,
  SchemaMeta,
} from '../../src/codegen/index.js'

const SCHEMA_PATH = '/project/db/schema.ts'
const MODELS_DIR = '/project/models/'

export type TestProjectConfig = {
  /** Source for the Drizzle schema file */
  schema: string
  /** Map of filename → source content, e.g. { 'Asset.model.ts': '...' } */
  models: Record<string, string>
}

export type CodegenRunResult = {
  /** Generated file path (relative to models dir) → content */
  files: Record<string, string>
  /** Errors (severity: 'error') */
  errors: Diagnostic[]
  /** Warnings (severity: 'warning') */
  warnings: Diagnostic[]
  /** The full IR, for deeper assertions */
  projectMeta: ProjectMeta
}

export type TestProject = {
  /** The underlying ts-morph project, for direct AST inspection */
  tsProject: Project

  /** Run only the schema extractor */
  extractSchema(): SchemaMeta

  /** Run only the model extractor for one file */
  extractModel(filename: string): ModelMeta

  /** Extract everything and run validation — returns all diagnostics */
  validate(): Diagnostic[]

  /** Run the full pipeline and return generated file contents */
  run(): CodegenRunResult
}

export function createTestProject(config: TestProjectConfig): TestProject {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      experimentalDecorators: true,
    },
  })

  project.createSourceFile(SCHEMA_PATH, config.schema)

  for (const [filename, content] of Object.entries(config.models)) {
    project.createSourceFile(`${MODELS_DIR}${filename}`, content)
  }

  return {
    tsProject: project,

    extractSchema(): SchemaMeta {
      return extractSchema(project, SCHEMA_PATH)
    },

    extractModel(filename: string): ModelMeta {
      return extractModel(project, `${MODELS_DIR}${filename}`)
    },

    validate(): Diagnostic[] {
      const schema = extractSchema(project, SCHEMA_PATH)
      const modelFiles = project
        .getSourceFiles()
        .map(f => f.getFilePath())
        .filter(p => p.startsWith(MODELS_DIR) && p.endsWith('.model.ts'))

      const models = modelFiles.map(path => extractModel(project, path))
      return validate({ schema, models })
    },

    run(): CodegenRunResult {
      const schema = extractSchema(project, SCHEMA_PATH)
      const modelFiles = project
        .getSourceFiles()
        .map(f => f.getFilePath())
        .filter(p => p.startsWith(MODELS_DIR) && p.endsWith('.model.ts'))

      const models = modelFiles.map(path => extractModel(project, path))
      const projectMeta: ProjectMeta = { schema, models }

      const diagnostics = validate(projectMeta)
      const generatedFiles = generate(projectMeta)

      return {
        files: Object.fromEntries(generatedFiles.map((f: GeneratedFile) => [f.path, f.content])),
        errors: diagnostics.filter(d => d.severity === 'error'),
        warnings: diagnostics.filter(d => d.severity === 'warning'),
        projectMeta,
      }
    },
  }
}

/** Convenience: assert a run result has no errors */
export function expectNoErrors(result: CodegenRunResult): void {
  if (result.errors.length > 0) {
    const messages = result.errors.map(e => `  ${e.modelFile}: ${e.message}`).join('\n')
    throw new Error(`Expected no codegen errors, but got:\n${messages}`)
  }
}

/** Convenience: assert a run result has specific error messages */
export function expectErrors(result: CodegenRunResult, ...patterns: (string | RegExp)[]): void {
  for (const pattern of patterns) {
    const matched = result.errors.some(e =>
      typeof pattern === 'string' ? e.message.includes(pattern) : pattern.test(e.message),
    )
    if (!matched) {
      const messages = result.errors.map(e => `  ${e.message}`).join('\n')
      throw new Error(
        `Expected an error matching ${String(pattern)}, but got:\n${messages || '  (no errors)'}`,
      )
    }
  }
}

/** Convenience: assert warnings */
export function expectWarnings(result: CodegenRunResult, ...patterns: (string | RegExp)[]): void {
  for (const pattern of patterns) {
    const matched = result.warnings.some(e =>
      typeof pattern === 'string' ? e.message.includes(pattern) : pattern.test(e.message),
    )
    if (!matched) {
      const messages = result.warnings.map(e => `  ${e.message}`).join('\n')
      throw new Error(
        `Expected a warning matching ${String(pattern)}, but got:\n${messages || '  (no warnings)'}`,
      )
    }
  }
}
