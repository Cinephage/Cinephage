import { SvelteSet } from 'svelte/reactivity';

/**
 * Selection state for a library list: the set of checked ids, whether checkboxes
 * are showing, and the header button's three-state cycle (off → select-all → off).
 *
 * The three lists had this written three times, and music's copy had lost
 * select-all and the Escape handler. One implementation, so they cannot drift.
 */
export interface ListSelection {
	/** The checked ids — pass straight to the card/table as `selectedItems`. */
	readonly ids: SvelteSet<string>;
	/** Are checkboxes visible? */
	readonly mode: boolean;
	readonly count: number;
	/** Header button: off → on with everything selected → off. */
	cycle(items: Array<{ id: string }>): void;
	/** Escape / the Done button: leave selection mode and drop the selection. */
	clear(): void;
	toggle(id: string, selected: boolean): void;
	selectAll(items: Array<{ id: string }>): void;
	/**
	 * Select everything once `load` resolves — unless select mode was left (or
	 * left and entered again) while it was loading, so a late answer never
	 * selects ids behind a closed select mode.
	 */
	selectAllWhenLoaded(load: () => Promise<Array<{ id: string }>>): Promise<void>;
	allSelected(items: Array<{ id: string }>): boolean;
	handleKeydown(event: KeyboardEvent): void;
}

export function createListSelection(): ListSelection {
	const ids = new SvelteSet<string>();
	let mode = $state(false);
	/** Bumped whenever select mode is left, so pending loads can tell. */
	let session = 0;

	const count = $derived(ids.size);

	function clear(): void {
		ids.clear();
		mode = false;
		session += 1;
	}

	function toggle(id: string, selected: boolean): void {
		if (selected) ids.add(id);
		else ids.delete(id);
	}

	function selectAll(items: Array<{ id: string }>): void {
		for (const item of items) ids.add(item.id);
	}

	async function selectAllWhenLoaded(
		load: () => Promise<Array<{ id: string }>>
	): Promise<void> {
		if (!mode) return;
		const started = session;
		const items = await load();
		if (!mode || session !== started) return;
		selectAll(items);
	}

	function allSelected(items: Array<{ id: string }>): boolean {
		return mode && ids.size > 0 && ids.size === items.length;
	}

	function cycle(items: Array<{ id: string }>): void {
		if (!mode) mode = true;
		else if (!allSelected(items)) selectAll(items);
		else clear();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && mode) clear();
	}

	return {
		get ids() {
			return ids;
		},
		get mode() {
			return mode;
		},
		get count() {
			return count;
		},
		cycle,
		clear,
		toggle,
		selectAll,
		selectAllWhenLoaded,
		allSelected,
		handleKeydown
	};
}
