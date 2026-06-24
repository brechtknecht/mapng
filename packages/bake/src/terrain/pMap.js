/** @layer core */
// Minimal bounded-concurrency map shared by the terrain fetch paths.

/**
 * Minimal concurrent map. Runs up to `concurrency` promises at once, collects
 * results in original order, and handles errors by storing null for failed items.
 * Checks the abort signal before starting each item so callers can cancel early.
 */
export async function pMap(items, mapper, concurrency, signal) {
  const results = new Array(items.length);
  let index = 0;

  const next = async () => {
    while (index < items.length) {
      signal?.throwIfAborted();
      const i = index++;
      try {
        results[i] = await mapper(items[i]);
      } catch (e) {
        console.error(`Error processing item ${i}`, e);
        // @ts-ignore - basic error handling
        results[i] = null;
      }
    }
  };

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(next());
  }
  await Promise.all(workers);
  return results;
}
