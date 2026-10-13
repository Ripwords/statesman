import { z } from 'zod'
import { projectSlug } from './project'

export type FileKind = 'vars' | 'backend' | 'env'

// Shell-safe on purpose: the .env file is sourced with `. ./.env.<env>`, and
// these names end up unquoted in TF_CLI_ARGS_* (checkout spec §5).
const fileName = z
  .string()
  .regex(
    /^[A-Za-z0-9._{}-]+$/,
    'must be a file name in this directory: letters, digits, . _ - and {env}'
  )
  .refine((n) => n !== '.' && n !== '..', 'must be a file name in this directory')

const AUTO_LOADED = /^(terraform\.tfvars(\.json)?|.*\.auto\.tfvars(\.json)?)$/

export const manifestSchema = z
  .object({
    server: z.url({ protocol: /^https?$/ }),
    project: z.string().refine((p) => {
      const parts = p.split('/')
      return parts.length === 2 && parts.every((s) => projectSlug.safeParse(s).success)
    }, 'must be org/project'),
    environments: z
      .array(projectSlug)
      .min(1)
      .refine((e) => new Set(e).size === e.length, 'must not repeat an environment'),
    files: z
      .object({
        vars: fileName.refine(
          (n) => n.endsWith('.tfvars') || n.endsWith('.tfvars.json'),
          'must end in .tfvars or .tfvars.json'
        ),
        backend: fileName.optional(),
        env: fileName.optional()
      })
      .strict()
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.environments.length < 2) return
    if (AUTO_LOADED.test(m.files.vars)) {
      ctx.addIssue({
        code: 'custom',
        path: ['files', 'vars'],
        message: `"${m.files.vars}" is loaded by Terraform for every environment, so one environment's values would leak into another's runs`
      })
    }
    for (const kind of ['vars', 'backend', 'env'] as const) {
      const pattern = m.files[kind]
      if (pattern !== undefined && !pattern.includes('{env}')) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', kind],
          message: `"${pattern}" has no {env}, so every environment would write the same file`
        })
      }
    }
  })

export type Manifest = z.infer<typeof manifestSchema>

export function fileFor(pattern: string, env: string): string {
  return pattern.replaceAll('{env}', env)
}

export function parseManifest(text: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('statesman.json: not valid JSON')
  }
  const result = manifestSchema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
  throw new Error(`statesman.json: ${where}${issue?.message ?? 'invalid'}`)
}
