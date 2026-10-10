import type { InternalApi } from 'nitropack/types'

/** One row of `GET /api/ui/projects`, typed by Nitro from the handler. */
export type ProjectRow = InternalApi['/api/ui/projects']['get'][number]
