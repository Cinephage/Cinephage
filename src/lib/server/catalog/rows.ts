/** Provider rows merge by id, first list first — charts overlap, shelves must not. */
export function mergeById<T extends { id: number }>(lists: T[][]): T[] {
	const seen = new Set<number>();
	const merged: T[] = [];
	for (const list of lists) {
		for (const item of list) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			merged.push(item);
		}
	}
	return merged;
}
