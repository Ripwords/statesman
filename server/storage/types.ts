/**
 * The one interface both storage drivers implement. The store sees only
 * ciphertext — encryption happens before it is called (spec §8).
 *
 * `get` returns null for a missing key. It never throws for absence, because
 * "no state yet" is a normal condition in the Terraform protocol, not an error.
 */
export interface StateStore {
  put(key: string, data: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}
