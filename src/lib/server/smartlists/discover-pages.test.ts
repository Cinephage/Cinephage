import { describe, expect, it } from 'vitest';
import { appendUniqueById } from './discover-pages.js';

describe('appendUniqueById', () => {
	it('skips ids already seen, also across calls', () => {
		const target: { id: number }[] = [];
		const seen = new Set<number>();
		appendUniqueById(target, [{ id: 1 }, { id: 2 }, { id: 2 }], seen);
		appendUniqueById(target, [{ id: 2 }, { id: 3 }], seen);
		expect(target.map((i) => i.id)).toEqual([1, 2, 3]);
		expect([...seen]).toEqual([1, 2, 3]);
	});

	it('stops at max without marking the rest as seen', () => {
		const target: { id: number }[] = [];
		const seen = new Set<number>();
		appendUniqueById(target, [{ id: 1 }, { id: 2 }, { id: 3 }], seen, 2);
		expect(target.map((i) => i.id)).toEqual([1, 2]);
		expect(seen.has(3)).toBe(false);
	});
});
