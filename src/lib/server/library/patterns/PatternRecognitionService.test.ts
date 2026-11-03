import { describe, it, expect } from 'vitest';
import {
	compilePatterns,
	matchIgnore,
	matchBonus,
	classifyFile,
	recognizeStructure,
	normalizeRelativePath,
	expandBonusFolderName,
	buildBonusPatterns,
	DEFAULT_IGNORE_PATTERNS,
	DEFAULT_BONUS_FOLDER_NAMES,
	DEFAULT_BONUS_FILE_PATTERNS,
	type PatternConfig,
	type CompiledPatterns
} from './PatternRecognitionService.js';

// Helper: compile a minimal config for tests
function compile(config: Partial<PatternConfig>): CompiledPatterns {
	return compilePatterns({
		ignore: config.ignore ?? { defaultEnabled: true, defaults: [], user: [] },
		bonus: config.bonus ?? { patterns: [] },
		structure: config.structure ?? null
	});
}

describe('PatternRecognitionService.normalizeRelativePath', () => {
	it('replaces backslashes with forward slashes', () => {
		expect(normalizeRelativePath('Movies\\Film.mkv')).toBe('Movies/Film.mkv');
	});

	it('strips a leading slash', () => {
		expect(normalizeRelativePath('/Movies/Film.mkv')).toBe('Movies/Film.mkv');
	});

	it('collapses duplicate slashes', () => {
		expect(normalizeRelativePath('Movies//Film.mkv')).toBe('Movies/Film.mkv');
	});

	it('handles Windows drive-like prefixes', () => {
		expect(normalizeRelativePath('C:\\Movies\\Film.mkv')).toBe('C:/Movies/Film.mkv');
	});
});

describe('PatternRecognitionService.expandBonusFolderName', () => {
	it('produces four variants', () => {
		const variants = expandBonusFolderName('Extras');
		expect(variants).toEqual(['/Extras/', '/Extras/*', '*/Extras/', '*/Extras/*']);
	});

	it('preserves spaces in folder names', () => {
		const variants = expandBonusFolderName('Behind the Scenes');
		expect(variants).toContain('*/Behind the Scenes/*');
	});
});

describe('PatternRecognitionService.buildBonusPatterns', () => {
	it('combines expanded folder names with file patterns', () => {
		const patterns = buildBonusPatterns(['Extras'], ['*trailer*']);
		expect(patterns).toContain('/Extras/');
		expect(patterns).toContain('*/Extras/*');
		expect(patterns).toContain('*trailer*');
	});
});

describe('PatternRecognitionService.matchIgnore', () => {
	it('matches a default ignore pattern', () => {
		const compiled = compile({
			ignore: { defaultEnabled: true, defaults: ['**/.git/**'], user: [] }
		});
		expect(matchIgnore('repo/.git/config', compiled)).toBe(true);
	});

	it('does not match when defaults are disabled', () => {
		const compiled = compile({
			ignore: { defaultEnabled: false, defaults: ['**/.git/**'], user: [] }
		});
		expect(matchIgnore('repo/.git/config', compiled)).toBe(false);
	});

	it('matches a user ignore pattern', () => {
		const compiled = compile({
			ignore: { defaultEnabled: false, defaults: [], user: ['*/Private/*'] }
		});
		expect(matchIgnore('Movies/Private/secret.mkv', compiled)).toBe(true);
		expect(matchIgnore('Movies/Public/film.mkv', compiled)).toBe(false);
	});

	it('respects case sensitivity (ignore is case-sensitive)', () => {
		const compiled = compile({
			ignore: { defaultEnabled: false, defaults: [], user: ['*.TMP'] }
		});
		expect(matchIgnore('file.TMP', compiled)).toBe(true);
		expect(matchIgnore('file.tmp', compiled)).toBe(false);
	});

	it('matches directory patterns with or without trailing slash', () => {
		const compiled = compile({
			ignore: { defaultEnabled: false, defaults: [], user: ['*/@eaDir/*'] }
		});
		expect(matchIgnore('Photos/@eaDir/thumb', compiled)).toBe(true);
	});

	it('matches dotfiles', () => {
		const compiled = compile({
			ignore: { defaultEnabled: true, defaults: ['**/.DS_Store'], user: [] }
		});
		expect(matchIgnore('Movies/.DS_Store', compiled)).toBe(true);
		expect(matchIgnore('Movies/Film.mkv', compiled)).toBe(false);
	});
});

describe('PatternRecognitionService.matchBonus', () => {
	it('matches a bonus pattern case-insensitively', () => {
		const compiled = compile({
			bonus: { patterns: ['*/EXTRAS/*'] }
		});
		expect(matchBonus('Movies/extras/clip.mkv', compiled)).toBe(true);
	});

	it('matches filename-token patterns', () => {
		const compiled = compile({
			bonus: { patterns: ['*trailer*'] }
		});
		expect(matchBonus('Movies/Avengers-trailer.mkv', compiled)).toBe(true);
		expect(matchBonus('Movies/Avengers.mkv', compiled)).toBe(false);
	});
});

describe('PatternRecognitionService.classifyFile', () => {
	it('returns null for ignored files (ignore wins)', () => {
		const compiled = compile({
			ignore: { defaultEnabled: false, defaults: [], user: ['*trailer*'] },
			bonus: { patterns: ['*trailer*'] }
		});
		// Both ignore and bonus match - ignore takes precedence.
		expect(classifyFile('Avengers-trailer.mkv', compiled)).toBeNull();
	});

	it('returns "bonus" for bonus-matching files', () => {
		const compiled = compile({
			bonus: { patterns: ['*trailer*'] }
		});
		expect(classifyFile('Avengers-trailer.mkv', compiled)).toBe('bonus');
	});

	it('returns "main" for regular files', () => {
		const compiled = compile({});
		expect(classifyFile('Movies/Avengers.mkv', compiled)).toBe('main');
	});
});

describe('PatternRecognitionService.recognizeStructure (folder_depth mode)', () => {
	const compiled = compile({
		structure: {
			mode: 'folder_depth',
			seriesFolderDepth: 0,
			seasonFolderDepth: 1
		}
	});

	it('extracts series title from the declared depth', () => {
		const result = recognizeStructure('Breaking Bad/Season 1/Episode 1.mkv', compiled);
		expect(result?.seriesTitle).toBe('Breaking Bad');
		expect(result?.season).toBe(1);
		expect(result?.episode).toBe(1);
		expect(result?.isBonus).toBe(false);
	});

	it('strips trailing year from series folder', () => {
		const result = recognizeStructure('The Matrix (1999)/Season 1/01.mkv', compiled);
		expect(result?.seriesTitle).toBe('The Matrix');
		expect(result?.year).toBeUndefined();
	});

	it('marks Season 00 as bonus', () => {
		const result = recognizeStructure('Firefly/Season 00/Special.mkv', compiled);
		expect(result?.season).toBe(0);
		expect(result?.isBonus).toBe(true);
	});

	it('marks Specials folder as season 0 bonus', () => {
		const result = recognizeStructure('Firefly/Specials/serenity.mkv', compiled);
		expect(result?.season).toBe(0);
		expect(result?.isBonus).toBe(true);
	});

	it('parses S01E02 episode numbers', () => {
		const result = recognizeStructure('Show/Season 1/Show S01E02.mkv', compiled);
		expect(result?.episode).toBe(2);
	});

	it('parses 1x02 episode numbers', () => {
		const result = recognizeStructure('Show/Season 1/Show 1x02.mkv', compiled);
		expect(result?.episode).toBe(2);
	});
});

describe('PatternRecognitionService.recognizeStructure (regex mode)', () => {
	const compiled = compile({
		structure: {
			mode: 'regex',
			seriesFolderRegexes: ['^(?P<title>.+)\\s*\\(?'],
			seasonFolderRegexes: ['^(?:Season|S)\\s*(?P<season>\\d{1,3})'],
			episodeFileRegexes: ['S\\d{1,3}E(?P<episode>\\d{1,3})']
		}
	});

	it('extracts title and season via named groups', () => {
		const result = recognizeStructure(
			'Battlestar Galactica/Season 02/Battlestar S02E03.mkv',
			compiled
		);
		expect(result?.seriesTitle).toBe('Battlestar Galactica');
		expect(result?.season).toBe(2);
		expect(result?.episode).toBe(3);
	});

	it('returns null when nothing matches the regexes', () => {
		const strict = compile({
			structure: {
				mode: 'regex',
				seriesFolderRegexes: ['^(?P<title>.+)\\s*\\(\\d{4}\\)'],
				seasonFolderRegexes: [],
				episodeFileRegexes: []
			}
		});
		// The series regex requires (YYYY) suffix - neither segment has it
		const result = recognizeStructure('random/file.mkv', strict);
		expect(result).toBeNull();
	});
});

describe('PatternRecognitionService.recognizeStructure (null structure)', () => {
	it('returns null for movie libraries (no structure settings)', () => {
		const compiled = compile({ structure: null });
		expect(recognizeStructure('Movies/Film.mkv', compiled)).toBeNull();
	});
});

describe('PatternRecognitionService default pattern sanity', () => {
	it('DEFAULT_IGNORE_PATTERNS includes common NAS cruft', () => {
		expect(DEFAULT_IGNORE_PATTERNS).toContain('**/.DS_Store');
		expect(DEFAULT_IGNORE_PATTERNS).toContain('**/@eaDir/**');
		expect(DEFAULT_IGNORE_PATTERNS).toContain('**/$RECYCLE.BIN/**');
		expect(DEFAULT_IGNORE_PATTERNS).toContain('**/.git/**');
	});

	it('DEFAULT_BONUS_FOLDER_NAMES includes standard extras folders', () => {
		expect(DEFAULT_BONUS_FOLDER_NAMES).toContain('Behind the Scenes');
		expect(DEFAULT_BONUS_FOLDER_NAMES).toContain('Extras');
		// 'Specials' and 'Season 00' are TV season folders, not movie extras;
		// they must NOT be classified as bonus content.
		expect(DEFAULT_BONUS_FOLDER_NAMES).not.toContain('Specials');
		expect(DEFAULT_BONUS_FOLDER_NAMES).not.toContain('Season 00');
	});

	it('DEFAULT_BONUS_FILE_PATTERNS catches trailer/teaser/promo/bonus filenames', () => {
		expect(DEFAULT_BONUS_FILE_PATTERNS).toContain('*trailer*');
		expect(DEFAULT_BONUS_FILE_PATTERNS).toContain('*teaser*');
		expect(DEFAULT_BONUS_FILE_PATTERNS).toContain('*promo*');
		expect(DEFAULT_BONUS_FILE_PATTERNS).toContain('*sample*');
		expect(DEFAULT_BONUS_FILE_PATTERNS).toContain('*bonus*');
	});

	it('full default config classifies a typical media library correctly', () => {
		const compiled = compilePatterns({
			ignore: { defaultEnabled: true, defaults: DEFAULT_IGNORE_PATTERNS, user: [] },
			bonus: {
				patterns: buildBonusPatterns(DEFAULT_BONUS_FOLDER_NAMES, DEFAULT_BONUS_FILE_PATTERNS)
			},
			structure: null
		});

		expect(classifyFile('Movies/Avengers.mkv', compiled)).toBe('main');
		expect(classifyFile('Movies/.DS_Store', compiled)).toBeNull();
		expect(classifyFile('Movies/@eaDir/Avengers/syncthing.conf', compiled)).toBeNull();
		expect(classifyFile('Movies/Avengers/trailer.mkv', compiled)).toBe('bonus');
		expect(classifyFile('Movies/Avengers/Extras/interview.mkv', compiled)).toBe('bonus');
	});
});
