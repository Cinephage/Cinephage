// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

import type { FacetView } from '#lib/filters/types.js';

type Keyword = { id: number; name: string };
type Pending = { resolve: (value: Keyword | null) => void; reject: (reason: unknown) => void };

const { getKeyword, pending } = vi.hoisted(() => {
	const pending = new Map<number, Pending[]>();
	const getKeyword = vi.fn(
		(id: number) =>
			new Promise<Keyword | null>((resolve, reject) => {
				pending.set(id, [...(pending.get(id) ?? []), { resolve, reject }]);
			})
	);
	return { getKeyword, pending };
});

vi.mock('#lib/api/index.js', () => ({ getKeyword }));
vi.mock('#lib/api/smartlists.js', () => ({ getSmartListHelpers: vi.fn().mockResolvedValue([]) }));

import KeywordsControl from './KeywordsControl.svelte';

function facet(include: string[]): FacetView {
	return {
		id: 'keywords',
		label: 'Keywords',
		control: 'keywords',
		options: [],
		value: { kind: 'keywords', include, exclude: [] }
	};
}

async function settle() {
	for (let i = 0; i < 3; i++) {
		await Promise.resolve();
		await tick();
	}
}

function resolve(id: number, name: string) {
	for (const entry of pending.get(id) ?? []) entry.resolve({ id, name });
}

function callsFor(id: number) {
	return getKeyword.mock.calls.filter(([arg]) => arg === id).length;
}

describe('KeywordsControl keyword lookups', () => {
	afterEach(() => {
		cleanup();
		getKeyword.mockClear();
		pending.clear();
	});

	it('looks each keyword up once while earlier lookups resolve', async () => {
		render(KeywordsControl, {
			props: { facet: facet(['3335', '232795', '318653']), onchange: vi.fn() }
		});
		await settle();

		resolve(232795, 'Second');
		await settle();
		resolve(3335, 'First');
		await settle();
		resolve(318653, 'Third');
		await settle();

		expect(callsFor(3335)).toBe(1);
		expect(callsFor(232795)).toBe(1);
		expect(callsFor(318653)).toBe(1);
		expect(getKeyword).toHaveBeenCalledTimes(3);
		expect(screen.getByText('First')).toBeTruthy();
		expect(screen.getByText('Second')).toBeTruthy();
		expect(screen.getByText('Third')).toBeTruthy();
	});

	it('keeps the id chip when a lookup fails', async () => {
		render(KeywordsControl, { props: { facet: facet(['42']), onchange: vi.fn() } });
		await settle();

		for (const entry of pending.get(42) ?? []) entry.reject(new Error('offline'));
		await settle();

		expect(callsFor(42)).toBe(1);
		expect(screen.getByText('42')).toBeTruthy();
	});
});
