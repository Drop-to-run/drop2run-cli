/**
 * Bounded concurrency that keeps results in input order.
 *
 * Two places walk a list one await at a time and pay for it in proportion to the list's length rather
 * than its size: hashing every file of a drop, and taking a handle on every file of a dropped folder.
 * Twenty thousand small files meant twenty thousand round trips to the disk in a row, each one waiting
 * for the last. Both need the same thing — several in flight, results still in the order the input
 * gave them, because the manifest and every test of it read that order — so it is written once here
 * rather than twice.
 */

/**
 * Maps every item through an async function with at most `limit` calls in flight.
 *
 * The first failure ends the map: no item is started after it, and the returned promise rejects with
 * that failure rather than with whatever the calls still in flight go on to throw. Calls already
 * running are left to finish on their own; there is nothing to cancel them with that the caller does
 * not already hold through `signal`.
 *
 * @param items What to map, in the order the results must keep.
 * @param limit Most calls in flight at once; values below one are treated as one.
 * @param fn Called once per item with the item and its index.
 * @param signal Stops starting new items once aborted, and rejects with its reason.
 * @returns One result per item, at the item's index.
 */
export async function mapInOrder<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failure: { readonly error: unknown } | null = null;

	/** Takes items off the shared cursor until there are none left or one has failed. */
	const lane = async (): Promise<void> => {
		for (;;) {
			if (failure !== null) return;
			signal?.throwIfAborted();

			// Read and incremented with no lock: JavaScript runs one task at a time, so no two lanes can see
			// the same index.
			const index = next++;
			if (index >= items.length) return;

			try {
				results[index] = await fn(items[index] as T, index);
			} catch (error) {
				failure ??= { error };
				return;
			}
		}
	};

	const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane);

	await Promise.all(lanes);

	if (failure !== null) throw (failure as { readonly error: unknown }).error;

	return results;
}
