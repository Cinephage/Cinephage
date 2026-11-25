/**
 * TMDB's discover pages are not a stable snapshot: when the sort order shifts between two
 * requests (popularity changes all the time), a title from page 1 can show up again on page 2.
 * Joining pages naively then yields the same TMDB id twice.
 */

/**
 * Append the items of `incoming` whose id is not in `seen` yet, until `target` holds `max`
 * items. `seen` is updated with every id that is appended.
 */
export function appendUniqueById<T extends { id: number }>(
	target: T[],
	incoming: readonly T[],
	seen: Set<number>,
	max = Number.POSITIVE_INFINITY
): void {
	for (const item of incoming) {
		if (target.length >= max) return;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		target.push(item);
	}
}
