import { describe, expect, it } from 'vitest';
import { extractSearchYear } from './search-query.js';

describe('extractSearchYear', () => {
	it.each([
		['Se7en (1995)', { title: 'Se7en', year: 1995 }],
		['Sling Blade 1996', { title: 'Sling Blade', year: 1996 }],
		['Sling Blade (1996-directors Cut)', { title: 'Sling Blade', year: 1996 }],
		['Se7en (1995 Remastered)', { title: 'Se7en', year: 1995 }],
		['Blade Runner 2049', { title: 'Blade Runner 2049' }],
		['2001: A Space Odyssey', { title: '2001: A Space Odyssey' }]
	])('extracts a trailing release year from %s', (query, expected) => {
		expect(extractSearchYear(query)).toEqual(expected);
	});
});
