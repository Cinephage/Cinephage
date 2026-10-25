import { describe, it, expect } from 'vitest';
import { createTemplateEngine } from './TemplateEngine';
import { createFilterEngine, parseDateWithLayout } from './FilterEngine';
import type { FilterBlock } from '../schema/yamlDefinition';

const RUTRACKER_STRIP_FILTERS: FilterBlock[] = [
	{
		name: 're_replace',
		args: ['[А-Яа-яЁё]+', '{{ if .Config.stripcyrillic }}{{ else }}$&{{ end }}']
	},
	{ name: 're_replace', args: ['^\\s*/\\s*', ''] },
	{ name: 're_replace', args: ['\\(\\s*/\\s*', '('] },
	{ name: 're_replace', args: ['(?:\\s*,\\s*){2,}', ', '] },
	{ name: 're_replace', args: ['\\[\\s*,\\s*', '['] },
	{ name: 're_replace', args: ['\\s*,\\s*\\]', ']'] },
	{ name: 're_replace', args: ['\\(\\s*,\\s*', '('] },
	{ name: 're_replace', args: ['\\s*,\\s*\\)', ')'] },
	{ name: 're_replace', args: ['\\(\\s*\\)', ''] },
	{ name: 're_replace', args: ['\\s{2,}', ' '] },
	{ name: 'trim' }
];

describe('FilterEngine RuTracker strip pipeline', () => {
	it('strips Cyrillic cleanly when stripcyrillic is enabled', () => {
		const templateEngine = createTemplateEngine();
		templateEngine.setConfig({ stripcyrillic: true });
		const filterEngine = createFilterEngine(templateEngine);

		const input =
			'Военная машина / War Machine (Патрик Хьюз / Patrick Hughes) [2026, Великобритания, Австралия, WEB-DL 2160p, HDR, Dolby Vision]';
		const output = filterEngine.applyFilters(input, RUTRACKER_STRIP_FILTERS);

		expect(output).toContain('War Machine');
		expect(output).toContain('Patrick Hughes');
		expect(output).toContain('WEB-DL 2160p');
		expect(output.startsWith('/')).toBe(false);
		expect(output).not.toMatch(/[А-Яа-яЁё]/);
		expect(output).not.toContain(', ,');
	});

	it('preserves Cyrillic when stripcyrillic is disabled', () => {
		const templateEngine = createTemplateEngine();
		templateEngine.setConfig({ stripcyrillic: false });
		const filterEngine = createFilterEngine(templateEngine);

		const input = 'Военная машина / War Machine';
		const output = filterEngine.applyFilters(input, RUTRACKER_STRIP_FILTERS);

		expect(output).toContain('Военная');
		expect(output).toContain('War Machine');
	});
});

const DATE_PARSER_TEST_CASES: { date: string; layout: string; expected: Date | null }[] = [
	{
		date: 'Friday, April 24, 2026 at 4:12am',
		layout: 'dddd, MMMM DD, YYYY at H:mma',
		expected: new Date(2026, 3, 24, 4, 12, 0, 0)
	},
	{ date: '2/3/2026', layout: 'M/D/YYYY', expected: new Date(2026, 1, 3, 0, 0, 0, 0) },
	{
		date: '2026-04-24T22:38:22+02:00',
		layout: 'YYYY-MM-DDTHH:mm:ssZ',
		expected: new Date('2026-04-24T20:38:22.000Z')
	},
	{
		date: 'Fri, 24 Apr 2026 04:12:22 +0100',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: new Date('2026-04-24T03:12:22.000Z')
	},
	// Real indexer pubDate values commonly carry incidental whitespace from
	// pretty-printed RSS/XML (leading/trailing, or doubled internal spaces).
	// A search request already succeeded and spent the tracker's API quota
	// before this parse ever runs, so these must not fail just because of
	// whitespace the layout otherwise matches token-for-token.
	{
		date: '  Fri, 24 Apr 2026 04:12:22 +0100  ',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: new Date('2026-04-24T03:12:22.000Z')
	},
	{
		date: 'Fri,  24 Apr 2026 04:12:22  +0100',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: new Date('2026-04-24T03:12:22.000Z')
	},
	{
		date: '14.11.2026 13:31',
		layout: 'DD.MM.YYYY HH:mm',
		expected: new Date(2026, 10, 14, 13, 31, 0, 0)
	},
	{
		date: '2026-04-2422:38:22 +02:00',
		layout: 'YYYY-MM-DDHH:mm:ss Z',
		expected: new Date('2026-04-24T20:38:22.000Z')
	},
	{
		date: '2026-04-24T22:38:22.123Z',
		layout: 'YYYY-MM-DDTHH:mm:ss.SSSZ',
		expected: new Date('2026-04-24T22:38:22.123Z')
	},
	// The weekday belongs to the date in the source offset, even across UTC midnight.
	{
		date: 'Fri, 24 Apr 2026 00:12:22 +1400',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: new Date('2026-04-23T10:12:22.000Z')
	},
	{
		date: 'Fri, 24 Apr 2026 23:12:22 -1200',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: new Date('2026-04-25T11:12:22.000Z')
	},
	{
		date: 'Friday, 24 Apr 2026 00:12:22 +14:00',
		layout: 'dddd, DD MMM YYYY HH:mm:ss Z',
		expected: new Date('2026-04-23T10:12:22.000Z')
	},
	{
		date: 'Fri, 24 Apr 2026 23:12:22 -0330',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: new Date('2026-04-25T02:42:22.000Z')
	},
	{
		date: 'Fri, 24 Apr 2026 00:12:22 Z',
		layout: 'ddd, DD MMM YYYY HH:mm:ss Z',
		expected: new Date('2026-04-24T00:12:22.000Z')
	},
	{
		date: 'Thu, 24 Apr 2026 00:12:22 +1400',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: null
	},
	{
		date: 'Sat, 24 Apr 2026 04:12:22 +0100',
		layout: 'ddd, DD MMM YYYY HH:mm:ss ZZ',
		expected: null
	},
	{
		date: '2026-04-24T22:38:22Z',
		layout: 'YYYY-MM-DDTHH:mm:ssZ',
		expected: new Date('2026-04-24T22:38:22.000Z')
	}
];

describe('FilterEngine date layout parser', () => {
	// Dates with an explicit offset represent an instant; offset-free dates use local time.
	it.each(DATE_PARSER_TEST_CASES)('parses "$date" with "$layout"', ({ date, layout, expected }) => {
		const output = parseDateWithLayout(date, layout);

		expect(output).toStrictEqual(expected);
	});
});
