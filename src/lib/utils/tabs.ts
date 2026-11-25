/**
 * Keyboard support for the WAI-ARIA tabs pattern (automatic activation).
 *
 * Markup contract: the element with role="tablist" gets the keydown handler, and every
 * role="tab" inside it carries data-tab="<id>" so the newly selected tab can be focused.
 */

/**
 * Index of the tab a key moves to, or null when the key is not a tab navigation key.
 * Left/Right wrap around; Home/End jump to the first/last tab.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowRight':
			return (current + 1) % count;
		case 'ArrowLeft':
			return (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}

/**
 * Keydown handler for a tablist: selects the next tab and moves focus to it
 * (selection follows focus).
 */
export function handleTablistKeydown<T extends string>(
	event: KeyboardEvent,
	ids: readonly T[],
	current: T,
	select: (id: T) => void
): void {
	const next = nextTabIndex(event.key, Math.max(0, ids.indexOf(current)), ids.length);
	if (next === null) return;
	event.preventDefault();
	const id = ids[next];
	select(id);
	(event.currentTarget as HTMLElement | null)
		?.querySelector<HTMLElement>(`[data-tab="${id}"]`)
		?.focus();
}
