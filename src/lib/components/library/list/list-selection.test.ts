import { describe, it, expect } from 'vitest';
import { createListSelection } from './list-selection.svelte.js';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('createListSelection', () => {
	it('cycles off → on with everything selected → off', () => {
		const selection = createListSelection();

		selection.cycle(items);
		expect(selection.mode).toBe(true);
		expect(selection.count).toBe(0);

		selection.cycle(items);
		expect(selection.allSelected(items)).toBe(true);
		expect([...selection.ids]).toEqual(['a', 'b', 'c']);

		selection.cycle(items);
		expect(selection.mode).toBe(false);
		expect(selection.count).toBe(0);
	});

	it('leaves select mode in one step with nothing or some selected', () => {
		const selection = createListSelection();

		selection.cycle(items);
		selection.clear();
		expect(selection.mode).toBe(false);
		expect(selection.count).toBe(0);

		selection.cycle(items);
		selection.toggle('b', true);
		selection.clear();
		expect(selection.mode).toBe(false);
		expect(selection.count).toBe(0);
	});

	it('tracks individual toggles without leaving selection mode', () => {
		const selection = createListSelection();

		selection.cycle(items);
		selection.toggle('b', true);

		expect(selection.count).toBe(1);
		expect(selection.mode).toBe(true);
		expect(selection.allSelected(items)).toBe(false);

		selection.toggle('b', false);
		expect(selection.count).toBe(0);
	});

	it('does not report all-selected for an empty list', () => {
		const selection = createListSelection();

		selection.cycle([]);

		expect(selection.mode).toBe(true);
		expect(selection.allSelected([])).toBe(false);
	});

	it('clears the selection on Escape only while selecting', () => {
		const selection = createListSelection();
		const escape = new KeyboardEvent('keydown', { key: 'Escape' });

		selection.handleKeydown(escape);
		expect(selection.mode).toBe(false);

		selection.cycle(items);
		selection.handleKeydown(escape);
		expect(selection.mode).toBe(false);
		expect(selection.count).toBe(0);
	});

	it('ignores keys other than Escape', () => {
		const selection = createListSelection();
		selection.cycle(items);

		selection.handleKeydown(new KeyboardEvent('keydown', { key: 'a' }));

		expect(selection.mode).toBe(true);
	});
});
