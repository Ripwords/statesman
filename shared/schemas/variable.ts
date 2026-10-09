import { z } from 'zod'
import { projectSlug } from './project'

/** One `variable` block as found in a linked repository on the last sync. */
export const declaredVariableSchema = z.object({
  name: z.string(),
  typeExpr: z.string().nullable(),
  hasDefault: z.boolean(),
  sensitive: z.boolean(),
  description: z.string().nullable(),
  file: z.string(),
  line: z.number().int().positive()
})
export type DeclaredVariable = z.infer<typeof declaredVariableSchema>

export const MAX_VALUE_BYTES = 65_536
export const MAX_VARIABLES_PER_ENVIRONMENT = 500

/**
 * Terraform's own identifier rule. A name Terraform cannot declare would be
 * stored, delivered, and then ignored at plan time with nothing but a warning,
 * so it is refused here instead.
 */
export const variableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*$/,
    'must start with a letter or underscore and contain only letters, digits, _ and -'
  )

/**
 * Anything `.tfvars.json` can carry. The size is measured on the serialised
 * form because that is what gets sealed and stored.
 */
export const variableValueSchema = z
  .json()
  .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_VALUE_BYTES, {
    message: `must be at most ${MAX_VALUE_BYTES / 1024} KiB once serialised`
  })
export type JsonValue = z.infer<typeof variableValueSchema>

/**
 * `value` is optional so a sensitive variable's sensitive flag or description
 * can change without its value ever travelling to the browser and back.
 * Whether an omitted value is acceptable depends on what is stored, so that
 * rule lives in the service, not here.
 */
export const setVariableSchema = z.object({
  value: variableValueSchema.optional(),
  sensitive: z.boolean().default(true),
  description: z.string().max(1024).nullish()
})
export type SetVariableInput = z.infer<typeof setVariableSchema>

const importValuesSchema = z
  .record(variableNameSchema, variableValueSchema)
  .refine((v) => Object.keys(v).length <= MAX_VARIABLES_PER_ENVIRONMENT, {
    message: `at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables per environment`
  })

export const importVariablesSchema = z.union([
  z.object({ values: importValuesSchema, dryRun: z.boolean().default(false) }),
  z.object({ hcl: z.string().max(1_048_576), dryRun: z.boolean().default(false) })
])
export type ImportVariablesInput = z.infer<typeof importVariablesSchema>

export const createEnvironmentSchema = z.object({ slug: projectSlug })

/** The associated data every variable is sealed under (variables spec §4). */
export function variableAad(environmentId: string, name: string): Buffer {
  return Buffer.from(`variable:${environmentId}:${name}`, 'utf8')
}
