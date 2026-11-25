// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dragScroll } from './drag-scroll.js';

function pointer(type: string, init: { x?: number; pointerType?: string; button?: number } = {}) {
	// jsdom has no PointerEvent constructor; a MouseEvent with the extra fields is enough.
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: init.x ?? 0,
		button: init.button ?? 0
	});
	Object.defineProperty(event, 'pointerId', { value: 1 });
	Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
	return event;
}

function makeRow(scrollWidth = 1000, clientWidth = 300) {
	const node = document.createElement('div');
	Object.defineProperty(node, 'scrollWidth', { value: scrollWidth, configurable: true });
	Object.defineProperty(node, 'clientWidth', { value: clientWidth, configurable: true });
	// jsdom does no layout, so give the row a plain clamped scrollLeft.
	let scrollLeft = 0;
	Object.defineProperty(node, 'scrollLeft', {
		configurable: true,
		get: () => scrollLeft,
		set: (v: number) => (scrollLeft = Math.min(scrollWidth - clientWidth, Math.max(0, v)))
	});
	node.setPointerCapture = vi.fn();
	node.hasPointerCapture = vi.fn(() => false);
	node.releasePointerCapture = vi.fn();
	const link = document.createElement('a');
	link.href = '#card';
	node.appendChild(link);
	document.body.appendChild(node);
	return { node, link };
}

describe('dragScroll', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = '';
	});

	it('shows a grab cursor only when the row can scroll', () => {
		const { node } = makeRow();
		dragScroll(node);
		expect(node.style.cursor).toBe('grab');

		const { node: short } = makeRow(300, 300);
		dragScroll(short);
		expect(short.style.cursor).toBe('');
	});

	it('scrolls the row with the mouse and swallows the click after a drag', () => {
		const { node, link } = makeRow();
		dragScroll(node, { momentum: false });
		const onClick = vi.fn();
		link.addEventListener('click', onClick);

		link.dispatchEvent(pointer('pointerdown', { x: 200 }));
		link.dispatchEvent(pointer('pointermove', { x: 150 }));
		expect(node.style.cursor).toBe('grabbing');
		expect(node.style.scrollSnapType).toBe('none');
		link.dispatchEvent(pointer('pointermove', { x: 100 }));
		expect(node.scrollLeft).toBe(100);
		link.dispatchEvent(pointer('pointerup', { x: 100 }));

		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		expect(onClick).not.toHaveBeenCalled();
		expect(click.defaultPrevented).toBe(true);
		expect(node.style.cursor).toBe('grab');
		expect(node.style.scrollSnapType).toBe('');

		// The next plain click goes through again.
		vi.runAllTimers();
		link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('glides on after a fast release and restores snapping when it stops', () => {
		const { node, link } = makeRow();
		node.style.scrollSnapType = 'x mandatory';
		dragScroll(node);

		link.dispatchEvent(pointer('pointerdown', { x: 200 }));
		link.dispatchEvent(pointer('pointermove', { x: 150 }));
		vi.advanceTimersByTime(16);
		link.dispatchEvent(pointer('pointermove', { x: 100 }));
		link.dispatchEvent(pointer('pointerup', { x: 100 }));
		const released = node.scrollLeft;
		expect(node.style.scrollSnapType).toBe('none');

		vi.advanceTimersByTime(2000);
		expect(node.scrollLeft).toBeGreaterThan(released);
		expect(node.style.scrollSnapType).toBe('x mandatory');
	});

	it('keeps the click when the mouse moved less than the threshold', () => {
		const { node, link } = makeRow();
		dragScroll(node);
		const onClick = vi.fn();
		link.addEventListener('click', onClick);

		link.dispatchEvent(pointer('pointerdown', { x: 200 }));
		link.dispatchEvent(pointer('pointermove', { x: 197 }));
		link.dispatchEvent(pointer('pointerup', { x: 197 }));
		link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

		expect(node.scrollLeft).toBe(0);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('leaves touch input to native scrolling', () => {
		const { node, link } = makeRow();
		dragScroll(node);

		link.dispatchEvent(pointer('pointerdown', { x: 200, pointerType: 'touch' }));
		link.dispatchEvent(pointer('pointermove', { x: 100, pointerType: 'touch' }));

		expect(node.scrollLeft).toBe(0);
		expect(node.setPointerCapture).not.toHaveBeenCalled();
	});

	it('ignores non-primary mouse buttons and can be disabled', () => {
		const { node, link } = makeRow();
		const action = dragScroll(node);

		link.dispatchEvent(pointer('pointerdown', { x: 200, button: 1 }));
		link.dispatchEvent(pointer('pointermove', { x: 100 }));
		expect(node.scrollLeft).toBe(0);

		action.update({ enabled: false });
		expect(node.style.cursor).toBe('');
		link.dispatchEvent(pointer('pointerdown', { x: 200 }));
		link.dispatchEvent(pointer('pointermove', { x: 100 }));
		expect(node.scrollLeft).toBe(0);
	});

	it('removes its listeners on destroy', () => {
		const { node, link } = makeRow();
		const action = dragScroll(node);
		action.destroy();

		expect(node.style.cursor).toBe('');
		link.dispatchEvent(pointer('pointerdown', { x: 200 }));
		link.dispatchEvent(pointer('pointermove', { x: 100 }));
		expect(node.scrollLeft).toBe(0);
	});
});
