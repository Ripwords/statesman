import { z } from 'zod'

// Shape is defined by Terraform's statemgr.LockInfo. Every field except ID is
// best-effort: older CLI versions and third-party tooling omit some of them.
export const lockInfoSchema = z.object({
  ID: z.string().min(1),
  Operation: z.string().optional(),
  Info: z.string().optional(),
  Who: z.string().optional(),
  Version: z.string().optional(),
  Created: z.string().optional(),
  Path: z.string().optional()
})

export type LockInfo = z.infer<typeof lockInfoSchema>
