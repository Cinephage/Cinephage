// @vitest-environment jsdom
/**
 * Open-path benchmark for the profile dialog.
 *
 * Opening a ModalWrapper used to force two full-page layouts inside the click
 * task: lockBodyScroll read html.clientWidth after the `.modal-open` node was
 * already in the document, and createFocusTrap read offsetParent on every
 * focusable element before the next frame. jsdom does no layout, so the test
 * counts the layout-forcing reads instead of timing them, and logs the mount
 * time for reference.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import ProfileModal from './ProfileModal.svelte';
import type { FormatCategory } from '#lib/types/format.js';

const CATEGORIES: FormatCategory[] = ['resolution', 'source', 'audio', 'hdr', 'codec', 'other'];

const allFormats = Array.from({ length: 400 }, (_, i) => ({
	id: `bench-format-${i}`,
	name: `Bench Format ${i}`,
	category: CATEGORIES[i % CATEGORIES.length]
}));

const indexers = Array.from({ length: 30 }, (_, i) => ({
	id: `ix-${i}`,
	name: `Indexer ${i}`,
	protocol: 'torrent' as const,
	enabled: true
}));

function wrapGetter<T extends object>(proto: T, prop: string, onRead: (el: Element) => void) {
	const original = Object.getOwnPropertyDescriptor(proto, prop);
	if (!original?.get) throw new Error(`no getter for ${prop}`);
	const get = original.get;
	Object.defineProperty(proto, prop, {
		configurable: true,
		get(this: Element) {
			onRead(this);
			return get.call(this);
		}
	});
	return () => Object.defineProperty(proto, prop, original);
}

describe('ProfileModal open path', () => {
	const restores: (() => void)[] = [];

	afterEach(() => {
		cleanup();
		restores.splice(0).forEach((restore) => restore());
		vi.unstubAllGlobals();
	});

	it('does not force layout while the dialog DOM is being inserted', () => {
		// Keep rAF callbacks queued so only synchronous work is counted.
		vi.stubGlobal('requestAnimationFrame', () => 0);

		let counting = false;
		let clientWidthReads = 0;
		let clientWidthReadsWithModal = 0;
		let offsetParentReads = 0;

		restores.push(
			wrapGetter(Element.prototype, 'clientWidth', () => {
				if (!counting) return;
				clientWidthReads++;
				if (document.querySelector('.modal-open')) clientWidthReadsWithModal++;
			}),
			wrapGetter(HTMLElement.prototype, 'offsetParent', () => {
				if (counting) offsetParentReads++;
			})
		);

		const { rerender } = render(ProfileModal, {
			props: {
				open: false,
				mode: 'add' as const,
				profile: null,
				allProfiles: [{ id: 'balanced', name: 'Balanced', isBuiltIn: true }],
				allFormats,
				indexers,
				onClose: vi.fn(),
				onSave: vi.fn()
			}
		});

		const runs = 20;
		const times: number[] = [];
		for (let i = 0; i < runs; i++) {
			counting = true;
			const start = performance.now();
			rerender({ open: true });
			flushSync();
			times.push(performance.now() - start);
			counting = false;
			rerender({ open: false });
			flushSync();
		}

		times.sort((a, b) => a - b);
		const median = times[Math.floor(times.length / 2)];
		console.info(
			`[profile-modal open] runs=${runs} median=${median.toFixed(1)}ms min=${times[0].toFixed(1)}ms ` +
				`clientWidth/open=${clientWidthReads / runs} (with modal in DOM: ${clientWidthReadsWithModal / runs}) ` +
				`offsetParent/open=${offsetParentReads / runs}`
		);

		expect(offsetParentReads).toBe(0);
		expect(clientWidthReadsWithModal).toBe(0);
		expect(clientWidthReads).toBe(runs);
	});
});
