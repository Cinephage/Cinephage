// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { lockBodyScroll } from './focus.js';

describe('lockBodyScroll', () => {
	beforeEach(() => {
		document.documentElement.style.overflow = '';
		document.documentElement.style.paddingRight = '';
	});

	it('locks and restores the original overflow on a single lock/unlock', () => {
		document.documentElement.style.overflow = 'auto';
		const unlock = lockBodyScroll();

		expect(document.documentElement.style.overflow).toBe('hidden');

		unlock();
		expect(document.documentElement.style.overflow).toBe('auto');
	});

	it('stays locked while any lock is still held, even if an earlier one is released', () => {
		document.documentElement.style.overflow = '';
		const unlockA = lockBodyScroll();
		const unlockB = lockBodyScroll();

		expect(document.documentElement.style.overflow).toBe('hidden');

		unlockA();
		// B is still held - must not restore yet.
		expect(document.documentElement.style.overflow).toBe('hidden');

		unlockB();
		expect(document.documentElement.style.overflow).toBe('');
	});

	// Regression: two modals in the same reactive flush (a list modal handing
	// off to a detail modal) call lockBodyScroll/unlock out of strict nesting
	// order. A non-reference-counted implementation has the second lock
	// capture 'hidden' (set by the first) as its "original" value, so the
	// final unlock restores to 'hidden' instead of the page's real style -
	// the page stays unscrollable until a hard refresh.
	it('restores the true original style when locks are released out of nesting order', () => {
		document.documentElement.style.overflow = 'auto';
		const unlockA = lockBodyScroll();
		const unlockB = lockBodyScroll();

		// Released in the same order they were acquired, not nested
		// (A closes, B opens to replace it, matching a modal handoff).
		unlockA();
		expect(document.documentElement.style.overflow).toBe('hidden');

		unlockB();
		expect(document.documentElement.style.overflow).toBe('auto');
	});

	it('ignores a second call to the same unlock function', () => {
		document.documentElement.style.overflow = 'scroll';
		const unlockA = lockBodyScroll();
		const unlockB = lockBodyScroll();

		unlockA();
		unlockA(); // double-release should not double-decrement the counter
		expect(document.documentElement.style.overflow).toBe('hidden');

		unlockB();
		expect(document.documentElement.style.overflow).toBe('scroll');
	});
});
