// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	createFocusTrap,
	getFirstFocusable,
	getFocusableElements,
	lockBodyScroll
} from './focus.js';

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

describe('focus trap visibility checks', () => {
	let frames: FrameRequestCallback[];
	let offsetParent: PropertyDescriptor | undefined;
	let offsetParentReads: number;
	let container: HTMLElement;

	beforeEach(() => {
		frames = [];
		offsetParentReads = 0;
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		});
		// jsdom does no layout; model visibility with the `hidden` attribute
		// and count every read, since each one forces layout in a browser.
		offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
		Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
			configurable: true,
			get(this: HTMLElement) {
				offsetParentReads++;
				return this.closest('[hidden]') ? null : document.body;
			}
		});
		container = document.createElement('div');
		container.innerHTML = `
			<div hidden><button type="button" data-id="hidden">Hidden</button></div>
			<input data-id="first" />
			<button type="button" data-id="second">Second</button>
			<button type="button" data-id="third">Third</button>
		`;
		document.body.appendChild(container);
	});

	afterEach(() => {
		container.remove();
		vi.unstubAllGlobals();
		if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
	});

	const runFrames = () => frames.splice(0).forEach((cb) => cb(performance.now()));
	const byId = (id: string) => container.querySelector<HTMLElement>(`[data-id="${id}"]`);

	it('getFirstFocusable skips hidden elements and stops at the first visible one', () => {
		expect(getFirstFocusable(container)).toBe(byId('first'));
		// hidden button + first input; the remaining buttons are never checked.
		expect(offsetParentReads).toBe(2);
	});

	it('getFocusableElements still returns every visible element', () => {
		expect(getFocusableElements(container)).toEqual([byId('first'), byId('second'), byId('third')]);
	});

	it('createFocusTrap does no visibility checks until the next frame', () => {
		const cleanupTrap = createFocusTrap(container);
		expect(offsetParentReads).toBe(0);
		expect(document.activeElement).not.toBe(byId('first'));

		runFrames();
		expect(offsetParentReads).toBeGreaterThan(0);
		expect(document.activeElement).toBe(byId('first'));
		cleanupTrap();
	});

	it('does not move focus if the trap is released before the frame', () => {
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();

		const cleanupTrap = createFocusTrap(container);
		cleanupTrap();
		runFrames();

		expect(document.activeElement).toBe(outside);
		outside.remove();
	});
});
