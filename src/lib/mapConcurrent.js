// Keep downloads bounded, and drain in-flight work before callers can retry.
// Results retain input order so database commits keep their existing ordering.
export async function mapConcurrent(items, mapper) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
  if (failed) throw failure;
  return results;
}
