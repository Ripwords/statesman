/**
 * Applies `task` to every item with at most `limit` tasks in flight, and
 * returns the results in input order.
 *
 * `Promise.all(items.map(task))` starts every task at once. That is fine for a
 * handful of cheap calls and wrong for a fan-out whose width is decided by the
 * data: the retention sweep walks the whole storage root once per project, so
 * an unbounded map is O(projects x blobs) of concurrent I/O and a deployment
 * with a few hundred projects can exhaust the connection pool, the file
 * descriptor table, or the S3 client's socket budget before it finishes one
 * pass.
 *
 * Workers pull from a shared cursor rather than being handed a fixed slice, so
 * one slow project does not idle the others.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`)
  }

  // Entries, not raw items: `queue[cursor]` is then a tuple that is undefined
  // only when the queue is exhausted. Testing the item itself for undefined
  // would end the loop early for a legitimately undefined element.
  const queue: [number, T][] = [...items.entries()]
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (let entry = queue[cursor++]; entry !== undefined; entry = queue[cursor++]) {
      results[entry[0]] = await task(entry[1])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
