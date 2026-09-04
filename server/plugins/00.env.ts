import { env } from '../utils/env'

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
export default defineNitroPlugin(() => {
  assertEnvironment()
})
