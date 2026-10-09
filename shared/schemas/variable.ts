import { z } from 'zod'

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
