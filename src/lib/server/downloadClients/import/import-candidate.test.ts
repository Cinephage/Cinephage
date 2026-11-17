import { describe, expect, it } from 'vitest';
import { classifyImportCandidate } from './import-candidate';

const MB = 1024 * 1024;

describe('classifyImportCandidate', () => {
	it('keeps a short episode below the generic 50MB floor when it names its episode', () => {
		expect(classifyImportCandidate('Show.S01E07.480p.x265.mkv', 35 * MB)).toEqual({
			importable: true
		});
		expect(classifyImportCandidate('Show - 1x07 - Recap.mkv', 35 * MB).importable).toBe(true);
	});

	it('still rejects tiny files, even with an episode marker', () => {
		expect(classifyImportCandidate('Show.S01E07.mkv', 4 * MB)).toEqual({
			importable: false,
			reason: 'too-small'
		});
	});

	it('keeps the 50MB floor for files without an episode marker', () => {
		expect(classifyImportCandidate('Some.Movie.2020.mkv', 35 * MB)).toEqual({
			importable: false,
			reason: 'too-small'
		});
	});

	it('keeps episodes whose title contains an extras word', () => {
		for (const name of [
			'Show.S02E05.The.Trailer.1080p.mkv',
			'Show.S01E04.Bonus.Round.mkv',
			'Extras.S01E01.720p.mkv',
			'Show.S03E02.Promo.Night.mkv'
		]) {
			expect(classifyImportCandidate(name, 900 * MB).importable, name).toBe(true);
		}
	});

	it('still rejects extras without an episode marker', () => {
		expect(classifyImportCandidate('Show.Season.1.Featurette.mkv', 900 * MB)).toEqual({
			importable: false,
			reason: 'extra-name'
		});
	});

	it('always rejects samples, by name or folder', () => {
		expect(classifyImportCandidate('Show.S01E01.sample.mkv', 900 * MB).importable).toBe(false);
		expect(classifyImportCandidate('Sample/Show.S01E01.mkv', 900 * MB)).toEqual({
			importable: false,
			reason: 'extra-folder'
		});
	});

	it('rejects files inside an extras folder of the download', () => {
		expect(classifyImportCandidate('Extras/Show.S01E01.Behind.mkv', 900 * MB)).toEqual({
			importable: false,
			reason: 'extra-folder'
		});
		expect(
			classifyImportCandidate('Show.S01/Deleted Scenes/Show.S01E01.mkv', 900 * MB).importable
		).toBe(false);
	});

	it('does not treat a release folder that merely contains an extras word as an extras folder', () => {
		expect(classifyImportCandidate('Extras.S01.1080p/Extras.S01E01.mkv', 900 * MB).importable).toBe(
			true
		);
	});

	it('accepts extensionless files only when the caller confirmed they are video', () => {
		expect(classifyImportCandidate('Show S01E01', 900 * MB).importable).toBe(false);
		expect(
			classifyImportCandidate('Show S01E01', 900 * MB, { extensionlessIsVideo: true }).importable
		).toBe(true);
	});

	it('accepts small .strm stubs for mount-mode clients', () => {
		expect(
			classifyImportCandidate('Show.S01E01.strm', 200, { allowStrmSmall: true }).importable
		).toBe(true);
	});
});
