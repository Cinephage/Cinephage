/**
 * RuTracker Title Filter Tests
 *
 * Tests the Russian title filtering logic to ensure titles are not
 * over-stripped when parsing RuTracker search results.
 */

import { describe, it, expect } from 'vitest';
import { createFilterEngine } from '../engine/FilterEngine.js';
import type { FilterBlock } from '../schema/yamlDefinition';

// RuTracker title filters - matches the updated rutracker.yaml configuration
const RUTRACKER_TITLE_FILTERS: FilterBlock[] = [
	// PHASE 1: Extract season/episode info
	{
		name: 're_replace',
		args: ['(?i)\\s*[СС]езоны?:?\\s*(\\d+).+?[СС]ери[ия]:?\\s*(\\d+-?\\d*)', ' S$1E$2']
	},
	{
		name: 're_replace',
		args: ['(?i)\\s*[СС]езоны?:?\\s*(\\d+)', ' S$1']
	},
	{
		name: 're_replace',
		args: ['(?i)\\s*[СС]ери[ия]:?\\s*(\\d+-?\\d*)', ' E$1']
	},
	{
		name: 're_replace',
		args: ['(?i)\\s*ТВ-?(\\d+)', ' S$1']
	},
	{
		name: 're_replace',
		args: ['\\[\\s*(\\d+)\\s*из\\s*(\\d+)\\s*\\]', ' E$1 of $2']
	},

	// PHASE 2: Strip metadata parentheses (NON-GREEDY)
	{
		name: 're_replace',
		args: [
			'(?i)\\s*\\([^\\)]{0,100}?\\b(?:Юбилейный|Лицензия|Itunes|BLU\\-?RAY|Blu-ray|BDRip|WEB\\-DL|HDTV|HDTVRip|SATRip|TVRip|DVD\\d?|DVD\\-?Rip|DVDScr|WEBRip|WEB\\-?Rip|WEB-DLRip|HDRip|BRRip|BDRemux|Remux|BD\\d|BD\\-?Rip|CAMRip|TeleSync|TS|HDTS|HD\\-?CAM|LD|Line\\.Dubbed|Line\\.Audio|FANSUB|Fansub|Hardsub|Softsub|Subtitles|Subs|VO|VoiceOver|Dub|Dubbed|MVO|P|A|Rus|Eng|Sub)\\b[^\\)]{0,50}?\\)',
			''
		]
	},

	// PHASE 3: Clean up metadata after slash (CONTEXT-AWARE)
	{
		name: 're_replace',
		args: ['(?i)\\s*/\\s*(?:Сезон|Сезоны|Season|Серии|Серия|Episode|Эпизод)[^/]{0,80}$', '']
	},

	// PHASE 4: Normalize quality tags
	{ name: 're_replace', args: ['(HDTVRip|HDRip|HDTV)', 'HDTV'] },
	{ name: 're_replace', args: ['(WEBRip|WEB-DLRip|WEB-DL)', 'WEB-DL'] },
	{
		name: 're_replace',
		args: ['(BDRip|BD\\d|BD\\-?Rip)', 'BDRip']
	},

	// PHASE 5: Handle Cyrillic (assuming stripcyrillic is false - preserve Cyrillic)
	// In actual use: '{{ if .Config.stripcyrillic }}{{ else }}$&{{ end }}'
	// For testing, we skip this or assume Cyrillic is preserved

	// PHASE 6: Clean up formatting
	{ name: 're_replace', args: ['^\\s*[-–-]+\\s*/\\s*', ''] },
	{ name: 're_replace', args: ['^\\s*/\\s*', ''] },
	{
		name: 're_replace',
		args: ['\\b(S\\d+E\\d+(?:-\\d+)?)\\s+(\\d{1,2})(?=\\s*\\[)', '$1 of $2']
	},
	{
		name: 're_replace',
		args: ['^(.*?)\\s*/\\s*(S\\d+E\\d+(?:-\\d+)?(?:\\s+of\\s+\\d+)?)', '$1: $2']
	},
	{ name: 're_replace', args: ['[(]\\s*/\\s*', '('] },
	{ name: 're_replace', args: ['(?:\\s*,\\s*){2,}', ', '] },
	{ name: 're_replace', args: ['[[]\\s*,\\s*', '['] },
	{ name: 're_replace', args: ['\\s*,\\s*[]]', ']'] },
	{ name: 're_replace', args: ['[(]\\s*,\\s*', '('] },
	{ name: 're_replace', args: ['\\s*,\\s*[)]', ')'] },
	{ name: 're_replace', args: ['[(]\\s*[)]', ''] },
	{ name: 're_replace', args: ['\\s{2,}', ' '] },

	// SAFETY: Final trim
	{ name: 'trim', args: [] }
];

describe('RuTracker Title Filters', () => {
	const engine = createFilterEngine();

	describe('Basic Russian Titles', () => {
		it('should preserve full Russian title with season/episode info', () => {
			const input =
				'Встать на ноги / Сезон: 1 / Серии: 1-8 из 8 (Павел Тимофеев) [2025, Россия, драма, WEBRip] + Sub (Rus, Eng)';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).not.toBe('');
			expect(result).toContain('Встать на ноги');
			expect(result).toContain('S1');
			expect(result).toContain('E1-8');
			expect(result.length).toBeGreaterThan(15);
		});

		it('should preserve Russian title with director name', () => {
			const input =
				'Здесь Был Юра (Сергей Малкин) [2025, Россия, драма, WEB-DL 1080p] + Original Rus + Sub Rus';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).not.toBe('');
			expect(result).toContain('Здесь Был Юра');
			expect(result.length).toBeGreaterThan(15);
		});

		it('should preserve simple Russian title', () => {
			const input = 'Название Фильма (2024) [WEB-DL 1080p]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).not.toBe('');
			expect(result).toContain('Название Фильма');
		});
	});

	describe('Edge Cases', () => {
		it('should handle metadata-only titles without destroying them', () => {
			const input = '[2025, WEB-DL]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			// This is an edge case - the title IS only metadata
			// The filter should preserve it rather than making it empty
			expect(result).not.toBe('');
		});

		it('should handle quality-only input', () => {
			const input = '  WEBDL 1080p';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			// This is poor input, but shouldn't be made worse (empty)
			expect(result).not.toBe('');
			expect(result).toContain('WEBDL');
		});

		it('should handle titles without season/episode info', () => {
			const input = 'Здесь Был Юра (Сергей Малкин) [2025, драма, WEB-DL]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).not.toBe('');
			expect(result).toContain('Здесь Был Юра');
		});

		it('should handle mixed English/Russian titles', () => {
			const input = 'Movie Name / Сезон 2 / Серии 1-12 (Director) [2024, WEBRip]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).not.toBe('');
			expect(result).toContain('Movie Name');
			expect(result).toContain('S2');
		});
	});

	describe('Season/Episode Extraction', () => {
		it('should extract SxEx format from Russian season/episode text', () => {
			const input = 'Сериал / Сезон: 3 / Серии: 5-10 из 12 [WEB-DL]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).toContain('S3');
			expect(result).toContain('E5-10');
		});

		it('should handle single season without episode range', () => {
			const input = 'Шоу / Сезон 1 [HDTV]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).toContain('Шоу');
			expect(result).toContain('S1');
		});

		it('should handle "из Y" format (X of Y episodes)', () => {
			const input = 'Сериал [8 из 12] [WEBRip]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).toContain('Сериал');
			expect(result).toContain('E8 of 12');
		});
	});

	describe('Quality Tag Normalization', () => {
		it('should normalize WEBRip variants to WEB-DL', () => {
			const input = 'Фильм [WEBRip 1080p]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).toContain('WEB-DL');
			expect(result).not.toContain('WEBRip');
		});

		it('should normalize HDTV variants', () => {
			const input = 'Шоу [HDTVRip]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).toContain('HDTV');
		});
	});

	describe('Title Validation', () => {
		it('should not return empty string for valid titles', () => {
			const testCases = [
				'Встать на ноги / Сезон: 1 / Серии: 1-8 из 8 [WEBRip]',
				'Здесь Был Юра [WEB-DL 1080p]',
				'Название Фильма (2024)',
				'Movie Name S01E01 [HDTV]'
			];

			testCases.forEach((input) => {
				const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);
				expect(result).not.toBe('');
				expect(result.trim().length).toBeGreaterThan(5);
			});
		});

		it('should preserve title when metadata stripping would be too aggressive', () => {
			// This was the bug - overly aggressive stripping left only quality tags
			const input =
				'Встать на ноги / Сезон: 1 / Серии: 1-8 из 8 (Павел Тимофеев) [2025, Россия, драма, WEBRip]';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			// Should contain the actual title, not just "WEBRip"
			expect(result).not.toMatch(/^\s*WEBRip\s*$/i);
			expect(result).not.toMatch(/^\s*WEB-DL\s*$/i);
			expect(result).toContain('Встать на ноги');
		});
	});

	describe('Real-World Examples from Issue #228', () => {
		it('should handle the exact failing title from the issue', () => {
			const input =
				'Встать на ноги / Сезон: 1 / Серии: 1-8 из 8 (Павел Тимофеев) [2025, Россия, драма, WEBRip] + Sub (Rus, Eng)';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			console.log('Input:', input);
			console.log('Output:', result);

			// Critical: Should NOT be empty or just quality tags
			expect(result).not.toBe('');
			expect(result).not.toMatch(/^\s*(WEB|WEB-DL|WEBRip|HDTV|HDRip|BDRip)\s*$/i);

			// Should contain the Russian title
			expect(result).toContain('Встать на ноги');

			// Should have season/episode info
			expect(result).toMatch(/S\d+/);

			// Should be reasonable length (not just a few chars)
			expect(result.length).toBeGreaterThan(15);
		});

		it('should handle title with multiple metadata sections', () => {
			const input =
				'Название / Сезон 1 / Серии 1-10 (Режиссер) [2024, Страна, жанр, WEB-DL 1080p] + Sub';
			const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

			expect(result).not.toBe('');
			expect(result).toContain('Название');
			expect(result.length).toBeGreaterThan(10);
		});
	});
});

describe('RuTracker Filter Edge Cases', () => {
	const engine = createFilterEngine();

	it('should handle empty input gracefully', () => {
		const result = engine.applyFilters('', RUTRACKER_TITLE_FILTERS);
		expect(result).toBe('');
	});

	it('should handle whitespace-only input', () => {
		const result = engine.applyFilters('   \t\n  ', RUTRACKER_TITLE_FILTERS);
		expect(result).toBe('');
	});

	it('should handle very long titles', () => {
		const input =
			'Очень Длинное Название Фильма Которое Может Встретиться В Реальной Жизни И Содержать Много Информации О Сезоне И Серии / Сезон 1 / Серии 1-100 [WEB-DL 1080p]';
		const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

		expect(result).not.toBe('');
		expect(result).toContain('Очень Длинное Название');
	});

	it('should handle titles with special characters', () => {
		const input = 'Фильм: Подзаголовок / Сезон 1 [WEBRip]';
		const result = engine.applyFilters(input, RUTRACKER_TITLE_FILTERS);

		expect(result).not.toBe('');
		expect(result).toContain('Фильм');
	});
});
