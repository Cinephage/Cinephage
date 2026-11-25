import { createFocusTrap, lockBodyScroll } from '#lib/utils/focus.js';

/**
 * Shared dismiss behaviour for hand-built overlays (drawers, sheets, popovers,
 * lightboxes) that do not go through ModalWrapper.
 *
 * Escape is listened for on the window, so it works wherever focus is (a
 * keydown handler on the backdrop only fires when the backdrop itself has
 * focus, which it never does after a tap). Only the most recently opened
 * overlay reacts, so Escape closes one layer at a time, and it leaves Escape
 * alone while focus is inside another modal dialog stacked on top.
 */
export interface DismissableOptions {
	/** Called when the overlay should close. */
	onDismiss: () => void;
	/** Close on Escape. Default true. */
	escape?: boolean;
	/**
	 * Close on a press outside the node. The click that follows is swallowed,
	 * so the tap only closes the overlay and does not also activate whatever
	 * was underneath (a link, a poster). Default false.
	 */
	outside?: boolean;
	/** Lock page scrolling while the overlay is open. Default false. */
	lockScroll?: boolean;
	/** Move focus into the overlay, trap Tab, and restore focus on close. Default false. */
	trapFocus?: boolean;
}

const stack: HTMLElement[] = [];

/** How long a dismissing press keeps swallowing its click (touch can lag a little). */
const SWALLOW_MS = 700;

export function dismissable(node: HTMLElement, options: DismissableOptions) {
	let opts = options;
	stack.push(node);

	const isTop = () => stack[stack.length - 1] === node;

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || opts.escape === false) return;
		if (event.defaultPrevented || !isTop()) return;
		const target = event.target instanceof Element ? event.target : null;
		const dialog = target?.closest('[aria-modal="true"]');
		if (dialog && dialog !== node && !node.contains(dialog) && !dialog.contains(node)) return;
		event.preventDefault();
		opts.onDismiss();
	}

	let removeSwallow: (() => void) | null = null;

	function swallowNextClick() {
		removeSwallow?.();
		const swallow = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			cleanup();
		};
		const timer = setTimeout(() => cleanup(), SWALLOW_MS);
		const cleanup = () => {
			clearTimeout(timer);
			window.removeEventListener('click', swallow, true);
			if (removeSwallow === cleanup) removeSwallow = null;
		};
		window.addEventListener('click', swallow, true);
		removeSwallow = cleanup;
	}

	function onPointerdown(event: PointerEvent) {
		if (!opts.outside || !isTop()) return;
		if (event.target instanceof Node && node.contains(event.target)) return;
		swallowNextClick();
		opts.onDismiss();
	}

	window.addEventListener('keydown', onKeydown);
	window.addEventListener('pointerdown', onPointerdown, true);
	const unlockScroll = opts.lockScroll ? lockBodyScroll() : null;
	const releaseFocus = opts.trapFocus ? createFocusTrap(node) : null;

	return {
		update(next: DismissableOptions) {
			opts = next;
		},
		destroy() {
			const index = stack.lastIndexOf(node);
			if (index !== -1) stack.splice(index, 1);
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('pointerdown', onPointerdown, true);
			// The swallow outlives the overlay on purpose: the press closes it,
			// then the click that follows must still be eaten.
			unlockScroll?.();
			releaseFocus?.();
		}
	};
}

const reopenCleanups = new WeakMap<HTMLElement, () => void>();

/**
 * Escape handler for daisyUI focus-driven dropdowns (`.dropdown` opened by
 * `:focus-within`): close the dropdown and return focus to its trigger.
 *
 * Blurring would close the menu but drop focus on <body>, and focusing the
 * trigger alone would match `:focus-within` and reopen it. daisyUI's
 * `dropdown-close` modifier hides the menu while focus stays on the trigger;
 * it is cleared again when the trigger is clicked (mouse, Enter or Space) or
 * focus leaves the dropdown. A second Escape, with the menu already closed,
 * is left alone so an outer overlay can still react to it.
 */
export function blurOnEscape(event: KeyboardEvent) {
	if (event.key !== 'Escape') return;
	const dropdown = event.currentTarget;
	if (!(dropdown instanceof HTMLElement)) return;
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !dropdown.contains(active)) return;
	if (dropdown.classList.contains('dropdown-close')) return;

	const trigger =
		dropdown.querySelector<HTMLElement>(':scope > :not(.dropdown-content)') ??
		(dropdown.firstElementChild instanceof HTMLElement ? dropdown.firstElementChild : null);

	event.preventDefault();
	dropdown.classList.add('dropdown-close');
	trigger?.focus();

	reopenCleanups.get(dropdown)?.();
	const reopen = () => {
		dropdown.classList.remove('dropdown-close');
		cleanup();
	};
	const onClick = (e: MouseEvent) => {
		if (trigger && e.target instanceof Node && trigger.contains(e.target)) reopen();
	};
	const onFocusout = (e: FocusEvent) => {
		if (!(e.relatedTarget instanceof Node) || !dropdown.contains(e.relatedTarget)) reopen();
	};
	const cleanup = () => {
		dropdown.removeEventListener('click', onClick);
		dropdown.removeEventListener('focusout', onFocusout);
		if (reopenCleanups.get(dropdown) === cleanup) reopenCleanups.delete(dropdown);
	};
	dropdown.addEventListener('click', onClick);
	dropdown.addEventListener('focusout', onFocusout);
	reopenCleanups.set(dropdown, cleanup);
}
