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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { H3Event } from 'h3'

export type ApiError = Error & {
  statusCode: number
  statusMessage: string | undefined
  data: unknown
}

type ErrorInput = { statusCode?: number; statusMessage?: string; data?: unknown }

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

type CookieOptions = Record<string, unknown>
type CookieWrite = { name: string; value: string | null; options: CookieOptions }
type TestEventContext = {
  params: Record<string, string>
  body: unknown
  query: Record<string, string>
  cookieWrites: CookieWrite[]
  redirect: string | null
  responseHeaders: Record<string, string>
}

function contextOf(event: H3Event): TestEventContext {
  const { context } = event as unknown as { context: Partial<TestEventContext> }
  return {
    params: context.params ?? {},
    body: context.body,
    query: context.query ?? {},
    cookieWrites: context.cookieWrites ?? [],
    redirect: context.redirect ?? null,
    responseHeaders: context.responseHeaders ?? {}
  }
}

function eventContext(event: H3Event): Partial<TestEventContext> {
  return (event as unknown as { context: Partial<TestEventContext> }).context
}

function readCookie(event: H3Event, name: string): string | undefined {
  const header = (event as unknown as { headers: Headers }).headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function writeCookie(event: H3Event, write: CookieWrite): void {
  const context = eventContext(event)
  context.cookieWrites = [...(context.cookieWrites ?? []), write]
}

Object.assign(globalThis, {
  defineEventHandler: <T>(handler: T): T => handler,
  createError: createErrorShim,
  getValidatedRouterParams: <T>(event: H3Event, validator: Validator<T>) =>
    runValidator(contextOf(event).params, validator),
  readValidatedBody: <T>(event: H3Event, validator: Validator<T>) =>
    runValidator(contextOf(event).body, validator),
  getValidatedQuery: <T>(event: H3Event, validator: Validator<T>) =>
    runValidator(contextOf(event).query, validator),
  getCookie: (event: H3Event, name: string) => readCookie(event, name),
  setCookie: (event: H3Event, name: string, value: string, options: CookieOptions = {}) =>
    writeCookie(event, { name, value, options }),
  deleteCookie: (event: H3Event, name: string, options: CookieOptions = {}) =>
    writeCookie(event, { name, value: null, options }),
  setResponseHeader: (event: H3Event, name: string, value: string) => {
    const context = eventContext(event)
    context.responseHeaders = { ...context.responseHeaders, [name.toLowerCase()]: value }
  },
  // h3 answers a redirect with 302 and a Location header; the test reads where it pointed.
  sendRedirect: (event: H3Event, location: string) => {
    eventContext(event).redirect = location
    return `Redirecting to ${location}`
  },
  useStorage: (_base: string) => ({
    getItemRaw: async (key: string) => readFileSync(join('server/assets', key.replaceAll(':', '/')))
  })
})

export type TestEventInit = {
  headers?: Record<string, string>
  params?: Record<string, string>
  body?: unknown
  query?: Record<string, string>
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
    context: { params: init.params ?? {}, body: init.body, query: init.query ?? {} }
  } as unknown as H3Event
}

/** What a handler did to the response, for tests that drive cookie, redirect and header routes. */
export function responseOf(event: H3Event): {
  cookieWrites: CookieWrite[]
  redirect: string | null
  headers: Record<string, string>
} {
  const { cookieWrites, redirect, responseHeaders } = contextOf(event)
  return { cookieWrites, redirect, headers: responseHeaders }
}
