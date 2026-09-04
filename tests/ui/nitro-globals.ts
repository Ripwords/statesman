/**
 * Nitro auto-imports h3's request helpers into `server/**` at build time.
 * Vitest loads those route modules as plain ESM with no build step, so the
 * globals have to be stood up by hand before any route module is imported —
 * the same trick `tests/setup.ts` already plays for `defineAppConfig` and
 * `defineNitroPlugin`.
 *
 * Import this module *before* any `server/api/**` module in a test file. ESM
 * evaluates a module's dependencies in declaration order, so a plain
 * `import './nitro-globals'` on the first line is enough.
 */
import type { H3Event } from 'h3'

export type ApiError = Error & {
  statusCode: number
  statusMessage: string | undefined
  data: unknown
}

type ErrorInput = { statusCode?: number, statusMessage?: string, data?: unknown }

export function isApiError(value: unknown): value is ApiError {
  return value instanceof Error && typeof (value as Partial<ApiError>).statusCode === 'number'
}

function createErrorShim(input: ErrorInput): ApiError {
  const error = new Error(input.statusMessage ?? 'Error') as ApiError
  error.statusCode = input.statusCode ?? 500
  error.statusMessage = input.statusMessage
  error.data = input.data
  return error
}

type Validator<T> = (data: unknown) => T | Promise<T>

/**
 * h3's `validateData` catches whatever the validator throws and re-raises it as
 * `400 Validation Error` — see CARRY-FORWARD §7c. The shim reproduces that so a
 * test cannot pass against behaviour the real server would not exhibit.
 */
async function runValidator<T>(data: unknown, validator: Validator<T>): Promise<T> {
  try {
    return await validator(data)
  } catch (cause) {
    throw createErrorShim({ statusCode: 400, statusMessage: 'Validation Error', data: cause })
  }
}

type TestEventContext = { params: Record<string, string>, body: unknown }

function contextOf(event: H3Event): TestEventContext {
  const { context } = event as unknown as { context: Partial<TestEventContext> }
  return { params: context.params ?? {}, body: context.body }
}

Object.assign(globalThis, {
  defineEventHandler: <T>(handler: T): T => handler,
  createError: createErrorShim,
  getValidatedRouterParams: <T>(event: H3Event, validator: Validator<T>) =>
    runValidator(contextOf(event).params, validator),
  readValidatedBody: <T>(event: H3Event, validator: Validator<T>) =>
    runValidator(contextOf(event).body, validator)
})

export type TestEventInit = {
  headers?: Record<string, string>
  params?: Record<string, string>
  body?: unknown
}

/**
 * A stand-in for the `H3Event` h3 builds from a real Node request. The cast is
 * unavoidable: `H3Event` is a class over a live request/response pair that
 * these tests deliberately do not have, and the handlers only ever read
 * `headers` and `context`.
 */
export function testEvent(init: TestEventInit = {}): H3Event {
  return {
    headers: new Headers(init.headers ?? {}),
    context: { params: init.params ?? {}, body: init.body }
  } as unknown as H3Event
}
