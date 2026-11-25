// @vitest-environment jsdom
/**
 * The shared drawer (library Options) closes on Escape wherever focus is and
 * locks page scrolling while it is open.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import Drawer from './Drawer.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>Drawer body</p>' }));

afterEach(() => {
	cleanup();
	document.documentElement.style.overflow = '';
});

describe('Drawer', () => {
	it('calls onClose on Escape', async () => {
		const onClose = vi.fn();
		render(Drawer, { props: { isOpen: true, title: 'Options', onClose, children } });
		await fireEvent.keyDown(document.body, { key: 'Escape' });
		expect(onClose).toHaveBeenCalled();
	});

	it('locks page scroll while open and releases it on unmount', async () => {
		const view = render(Drawer, {
			props: { isOpen: true, title: 'Options', onClose: vi.fn(), children }
		});
		expect(document.documentElement.style.overflow).toBe('hidden');
		view.unmount();
		expect(document.documentElement.style.overflow).toBe('');
	});
});
