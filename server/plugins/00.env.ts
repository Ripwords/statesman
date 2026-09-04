import { env } from '../utils/env'
import { assertHealthy } from '../utils/health'

/**
 * Parses and caches the environment, throwing on anything invalid.
 *
 * Exported separately from the plugin so the boot guard can be tested without
 * standing up a Nitro app; the plugin runs exactly this.
 */
export function assertEnvironment(): void {
  env()
}

/**
 * The global constraint is that the process refuses to boot without a valid
 * STATESMAN_ENCRYPTION_KEY. Validating lazily inside env() is not enough on its
 * own: Nitro registers every route handler lazily, so a server with no key
 * would start, serve SSR pages, and only fail on the first API request — long
 * after the operator has stopped watching the logs.
 *
 * The `00.` prefix orders this ahead of any other plugin.
 */
export default defineNitroPlugin(async () => {
  // Tier 1: configuration. Deterministic — retrying changes nothing.
  //
  // The throw has to be caught and turned into an exit for the same reason the
  // Tier 2 check below does. An earlier comment here claimed this call was
  // synchronous and therefore aborted module evaluation; it is not, because the
  // plugin is async, so the throw became a rejected promise that Nitro's
  // unhandledRejection handler logged and shrugged off. Measured against the
  // built server with no key: it printed the error, bound the port, and served
  // traffic it could not encrypt. Only docker-compose's `${VAR:?}` was stopping
  // that, which protects nothing under `docker run`, Kubernetes, ECS or Fly.
  try {
    assertEnvironment()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  // Tier 2: connectivity. Fatal on a long-running server, skipped on
  // serverless.
  //
  // Throwing is NOT enough here either, for the same reason. Nitro's
  // runNitroPlugins calls each plugin without awaiting it, so a rejected async
  // plugin escapes its try/catch and lands in Nitro's unhandledRejection
  // handler, which logs and keeps running. Measured: the server bound the port,
  // logged the failure, and went on serving traffic against a database it could
  // not reach. The spec requires the process to die loudly so the orchestrator
  // reports a broken deploy, so the exit is explicit.
  //
  // The listen has already happened by the time this resolves — an async check
  // cannot gate a synchronous bind — so this is a fast crash, not a barrier.
  try {
    await assertHealthy()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})
