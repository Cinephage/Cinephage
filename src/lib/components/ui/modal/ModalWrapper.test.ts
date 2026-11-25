// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import ModalWrapper from './ModalWrapper.svelte';

const children = createRawSnippet(() => ({
	render: () => '<div><input data-testid="first-input" /><button type="button">Ok</button></div>'
}));

describe('ModalWrapper', () => {
	let frames: FrameRequestCallback[];
	let offsetParent: PropertyDescriptor | undefined;

	const runFrames = () => {
		const queued = frames.splice(0);
		queued.forEach((cb) => cb(performance.now()));
	};

	beforeEach(() => {
		frames = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		});
		// jsdom does no layout, so offsetParent is always null; treat every
		// element as visible.
		offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
		Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
			configurable: true,
			get: () => document.body
		});
		document.documentElement.style.overflow = 'auto';
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
		document.documentElement.style.overflow = '';
	});

	it('locks page scroll while open and restores it on close', () => {
		const { rerender } = render(ModalWrapper, {
			props: { open: false, onClose: vi.fn(), children }
		});
		expect(document.documentElement.style.overflow).toBe('auto');

		rerender({ open: true });
		flushSync();
		expect(document.documentElement.style.overflow).toBe('hidden');

		rerender({ open: false });
		flushSync();
		expect(document.documentElement.style.overflow).toBe('auto');
	});

	it('does not lock page scroll when lockScroll is false', () => {
		render(ModalWrapper, { props: { open: true, lockScroll: false, onClose: vi.fn(), children } });
		expect(document.documentElement.style.overflow).toBe('auto');
	});

	it('restores the original overflow only after both stacked modals close', () => {
		const a = render(ModalWrapper, { props: { open: true, onClose: vi.fn(), children } });
		const b = render(ModalWrapper, { props: { open: true, onClose: vi.fn(), children } });
		expect(document.documentElement.style.overflow).toBe('hidden');

		a.rerender({ open: false });
		flushSync();
		expect(document.documentElement.style.overflow).toBe('hidden');

		b.rerender({ open: false });
		flushSync();
		expect(document.documentElement.style.overflow).toBe('auto');
	});

	it('moves focus to the first focusable element on the next frame', () => {
		const { getByTestId } = render(ModalWrapper, {
			props: { open: true, onClose: vi.fn(), children }
		});
		const input = getByTestId('first-input');
		expect(document.activeElement).not.toBe(input);

		runFrames();
		expect(document.activeElement).toBe(input);
	});

	it('calls onClose on Escape', async () => {
		const onClose = vi.fn();
		render(ModalWrapper, { props: { open: true, onClose, children } });

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
