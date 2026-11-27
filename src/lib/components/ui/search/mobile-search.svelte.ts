import { flushSync } from 'svelte';

/**
 * Phone-width search that sits behind an icon button in a page toolbar.
 *
 * The field is shown while the person has opened it, and always while a
 * query is active (so a filtered list never hides why it is filtered). The
 * button (`MobileSearchToggle`) and the field row (`MobileSearchPanel`) live
 * in different parts of the toolbar and share one instance of this state.
 */
export class MobileSearch {
	/** Opened by the person (tap on the icon, or focus inside the field). */
	open = $state(false);
	button = $state<HTMLButtonElement>();
	panel = $state<HTMLElement>();
	readonly id: string;
	readonly #isActive: () => boolean;

	constructor(id: string, isActive: () => boolean) {
		this.id = id;
		this.#isActive = isActive;
	}

	get active(): boolean {
		return this.#isActive();
	}

	get expanded(): boolean {
		return this.open || this.active;
	}

	/** Shows the field and focuses it inside the same tap, so phones raise the keyboard. */
	show(): void {
		this.open = true;
		flushSync();
		this.panel?.querySelector<HTMLInputElement>('input')?.focus();
	}

	/**
	 * Collapses the field unless a query keeps it on screen. `restoreFocus`
	 * puts focus back on the icon (Escape, close button); an outside tap
	 * leaves focus where the person tapped.
	 */
	hide(restoreFocus = false): void {
		this.open = false;
		if (this.active) return;
		if (restoreFocus) {
			flushSync();
			this.button?.focus();
		}
	}

	toggle(): void {
		if (this.expanded && !this.active) this.hide(true);
		else this.show();
	}
}
