/**
 * Focus management utilities for modals and dialogs
 */

const FOCUSABLE_SELECTORS = [
	'button:not([disabled]):not([tabindex="-1"])',
	'input:not([disabled]):not([tabindex="-1"])',
	'select:not([disabled]):not([tabindex="-1"])',
	'textarea:not([disabled]):not([tabindex="-1"])',
	'[tabindex]:not([tabindex="-1"])',
	'a[href]:not([tabindex="-1"])',
	'[contenteditable="true"]:not([tabindex="-1"])'
].join(', ');

/**
 * Get all focusable elements within a container
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)).filter(
		(el) => el.offsetParent !== null // Filter out hidden elements
	);
}

/**
 * Get the first focusable element in a container
 */
export function getFirstFocusable(container: HTMLElement): HTMLElement | null {
	const focusable = getFocusableElements(container);
	return focusable[0] ?? null;
}

/**
 * Create a focus trap within a container element.
 * Returns a cleanup function to remove the trap.
 */
export function createFocusTrap(container: HTMLElement): () => void {
	const previouslyFocused = document.activeElement as HTMLElement | null;

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;

		const focusable = getFocusableElements(container);
		if (focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable[focusable.length - 1];

		if (event.shiftKey) {
			// Shift+Tab: if on first element, wrap to last
			if (document.activeElement === first) {
				event.preventDefault();
				last.focus();
			}
		} else {
			// Tab: if on last element, wrap to first
			if (document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}

	container.addEventListener('keydown', handleKeydown);

	// Focus first focusable element
	const firstFocusable = getFirstFocusable(container);
	if (firstFocusable) {
		// Small delay to ensure DOM is ready
		requestAnimationFrame(() => {
			firstFocusable.focus();
		});
	}

	// Return cleanup function
	return () => {
		container.removeEventListener('keydown', handleKeydown);
		// Restore focus to previously focused element
		if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
			previouslyFocused.focus();
		}
	};
}

/**
 * Lock body scroll when modal is open.
 *
 * Uses overflow:hidden on <html> rather than position:fixed on <body> so that
 * DaisyUI drawer-side's position:sticky keeps its scroll reference and the
 * sidebar does not jump to the top when the modal opens.
 *
 * Reference-counted: when two modals are stacked (e.g. a list modal handing
 * off to a detail modal in the same reactive flush), each one's ModalWrapper
 * calls this independently. A plain "snapshot original style, then restore
 * it" implementation breaks here - whichever call runs second captures
 * 'hidden' (set by the first) as its "original" value, so unlocking it
 * restores to 'hidden' instead of the page's real default, leaving the page
 * permanently unscrollable until a hard refresh. The counter ensures only
 * the first lock call captures the true original style and only the last
 * unlock call restores it.
 */
let lockCount = 0;
let originalOverflow = '';
let originalPaddingRight = '';

export function lockBodyScroll(): () => void {
	const html = document.documentElement;

	if (lockCount === 0) {
		const scrollbarWidth = window.innerWidth - html.clientWidth;
		originalOverflow = html.style.overflow;
		originalPaddingRight = html.style.paddingRight;

		html.style.overflow = 'hidden';
		// Compensate for scrollbar disappearance to prevent layout shift
		if (scrollbarWidth > 0) {
			html.style.paddingRight = `${scrollbarWidth}px`;
		}
	}
	lockCount++;

	let released = false;
	return () => {
		if (released) return;
		released = true;
		lockCount--;
		if (lockCount <= 0) {
			lockCount = 0;
			html.style.overflow = originalOverflow;
			html.style.paddingRight = originalPaddingRight;
		}
	};
}
