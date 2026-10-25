/**
 * Matcher Logic Tests
 *
 * Tests for condition evaluation, format matching, and edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	evaluateCondition,
	evaluateFormat,
	matchFormats,
	matchesFormat,
	extractAttributes,
	clearPatternCache
} from './matcher';
import type { ReleaseAttributes, CustomFormat, FormatCondition } from './types';

// Helper to create a test release with defaults
function createRelease(overrides: Partial<ReleaseAttributes> = {}): ReleaseAttributes {
	const hdr = overrides.hdr === undefined ? 'dolby-vision' : overrides.hdr;
	return {
		title: 'Movie.2024.2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.Atmos.7.1-GROUP',
		cleanTitle: 'Movie',
		year: 2024,
		resolution: '2160p',
		source: 'bluray',
		codec: 'h265',
		hdr,
		hdrFormats: overrides.hdrFormats ?? (hdr ? [hdr] : []),
		audioCodec: 'truehd',
		audioChannels: '7.1',
		hasAtmos: true,
		releaseGroup: 'GROUP',
		isRemux: true,
		isRepack: false,
		isProper: false,
		is3d: false,
		languages: ['english'],
		...overrides
	};
}

// Helper to create a condition
function createCondition(overrides: Partial<FormatCondition>): FormatCondition {
	return {
		name: 'Test Condition',
		type: 'resolution',
		required: true,
		negate: false,
		...overrides
	} as FormatCondition;
}

// Helper to create a format
function createFormat(
	conditions: FormatCondition[],
	overrides: Partial<CustomFormat> = {}
): CustomFormat {
	return {
		id: 'test-format',
		name: 'Test Format',
		description: 'Test format description',
		category: 'other',
		tags: [],
		conditions,
		...overrides
	};
}

describe('Matcher', () => {
	beforeEach(() => {
		clearPatternCache();
	});

	// =========================================================================
	// Condition Type Tests
	// =========================================================================
	describe('Condition Types', () => {
		describe('resolution', () => {
			it('matches exact resolution', () => {
				const condition = createCondition({ type: 'resolution', resolution: '2160p' });
				const release = createRelease({ resolution: '2160p' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
				expect(result.rawMatch).toBe(true);
			});

			it('does not match different resolution', () => {
				const condition = createCondition({ type: 'resolution', resolution: '2160p' });
				const release = createRelease({ resolution: '1080p' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false);
			});
		});

		describe('source', () => {
			it('matches exact source', () => {
				const condition = createCondition({ type: 'source', source: 'bluray' });
				const release = createRelease({ source: 'bluray' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('does not match different source', () => {
				const condition = createCondition({ type: 'source', source: 'webdl' });
				const release = createRelease({ source: 'bluray' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false);
			});
		});

		describe('release_title', () => {
			it('matches regex pattern in title', () => {
				const condition = createCondition({
					type: 'release_title',
					pattern: 'REMUX'
				});
				const release = createRelease({ title: 'Movie.2024.2160p.BluRay.REMUX' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('is case insensitive', () => {
				const condition = createCondition({
					type: 'release_title',
					pattern: 'remux'
				});
				const release = createRelease({ title: 'Movie.2024.2160p.BluRay.REMUX' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('supports complex regex', () => {
				const condition = createCondition({
					type: 'release_title',
					pattern: '\\b(HDR10|DV|DoVi)\\b'
				});
				const release = createRelease({ title: 'Movie.2024.2160p.BluRay.DV.HDR' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('handles invalid regex gracefully', () => {
				const condition = createCondition({
					type: 'release_title',
					pattern: '[invalid('
				});
				const release = createRelease({ title: 'Movie.2024' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false); // Invalid regex returns never-match pattern
			});
		});

		describe('release_group', () => {
			it('matches exact release group', () => {
				const condition = createCondition({
					type: 'release_group',
					pattern: '^SPARKS$'
				});
				const release = createRelease({ releaseGroup: 'SPARKS' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches release group with partial pattern', () => {
				const condition = createCondition({
					type: 'release_group',
					pattern: 'FLUX'
				});
				const release = createRelease({ releaseGroup: 'FLUXiOM' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('does not match when release group is missing', () => {
				const condition = createCondition({
					type: 'release_group',
					pattern: 'SPARKS'
				});
				const release = createRelease({ releaseGroup: undefined });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false);
			});
		});

		describe('codec', () => {
			it('matches exact codec', () => {
				const condition = createCondition({ type: 'codec', codec: 'h265' });
				const release = createRelease({ codec: 'h265' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});
		});

		describe('audio_codec / audio_channels / audio_atmos', () => {
			it('matches exact audio codec', () => {
				const condition = createCondition({ type: 'audio_codec', audioCodec: 'truehd' });
				const release = createRelease({ audioCodec: 'truehd' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches audio channels', () => {
				const condition = createCondition({ type: 'audio_channels', audioChannels: '7.1' });
				const release = createRelease({ audioChannels: '7.1' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches atmos from canonical hasAtmos flag', () => {
				const condition = createCondition({ type: 'audio_atmos' });
				const release = createRelease({ hasAtmos: true, title: 'Movie.2024' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches atmos from title when parser set hasAtmos', () => {
				const condition = createCondition({ type: 'audio_atmos' });
				const release = createRelease({
					hasAtmos: true,
					title: 'Movie.2024.2160p.TrueHD.Atmos-GROUP'
				});

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches base audio codec from audioCodec', () => {
				const condition = createCondition({ type: 'audio_codec', audioCodec: 'dd+' });
				const release = createRelease({ audioCodec: 'dd+' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});
		});

		describe('hdr', () => {
			it('matches exact HDR type', () => {
				const condition = createCondition({ type: 'hdr', hdr: 'dolby-vision' });
				const release = createRelease({ hdr: 'dolby-vision' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches null HDR (SDR)', () => {
				const condition = createCondition({ type: 'hdr', hdr: null });
				const release = createRelease({ hdr: null });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches sdr keyword for SDR content', () => {
				const condition = createCondition({ type: 'hdr', hdr: 'sdr' });
				const release = createRelease({ hdr: null });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('does not match when HDR types differ', () => {
				const condition = createCondition({ type: 'hdr', hdr: 'hdr10' });
				const release = createRelease({ hdr: 'dolby-vision' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false);
			});

			it('matches a format present alongside a better one (#640)', () => {
				// DV is the headline format, but the release really is HDR10+ too.
				const release = createRelease({ hdrFormats: ['dolby-vision', 'hdr10+'] });
				const condition = createCondition({ type: 'hdr', hdr: 'hdr10+' });

				expect(evaluateCondition(condition, release).matches).toBe(true);
			});

			it('does not match SDR when any HDR format was detected (#640)', () => {
				const release = createRelease({ hdr: 'dolby-vision', hdrFormats: ['dolby-vision'] });
				const condition = createCondition({ type: 'hdr', hdr: null });

				expect(evaluateCondition(condition, release).matches).toBe(false);
			});
		});

		describe('streaming_service', () => {
			it('matches streaming service (case insensitive)', () => {
				const condition = createCondition({
					type: 'streaming_service',
					streamingService: 'AMZN'
				});
				const release = createRelease({ streamingService: 'amzn' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('does not match different streaming service', () => {
				const condition = createCondition({
					type: 'streaming_service',
					streamingService: 'NF'
				});
				const release = createRelease({ streamingService: 'AMZN' });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false);
			});
		});

		describe('flag', () => {
			it('matches isRemux flag', () => {
				const condition = createCondition({ type: 'flag', flag: 'isRemux' });
				const release = createRelease({ isRemux: true });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches isRepack flag', () => {
				const condition = createCondition({ type: 'flag', flag: 'isRepack' });
				const release = createRelease({ isRepack: true });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches isProper flag', () => {
				const condition = createCondition({ type: 'flag', flag: 'isProper' });
				const release = createRelease({ isProper: true });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('matches is3d flag', () => {
				const condition = createCondition({ type: 'flag', flag: 'is3d' });
				const release = createRelease({ is3d: true });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(true);
			});

			it('does not match when flag is false', () => {
				const condition = createCondition({ type: 'flag', flag: 'isRemux' });
				const release = createRelease({ isRemux: false });

				const result = evaluateCondition(condition, release);
				expect(result.matches).toBe(false);
			});
		});
	});

	// =========================================================================
	// Negation Tests
	// =========================================================================
	describe('Negation', () => {
		it('negates a matching condition', () => {
			const condition = createCondition({
				type: 'resolution',
				resolution: '2160p',
				negate: true
			});
			const release = createRelease({ resolution: '2160p' });

			const result = evaluateCondition(condition, release);
			expect(result.rawMatch).toBe(true);
			expect(result.matches).toBe(false);
		});

		it('negates a non-matching condition', () => {
			const condition = createCondition({
				type: 'resolution',
				resolution: '2160p',
				negate: true
			});
			const release = createRelease({ resolution: '1080p' });

			const result = evaluateCondition(condition, release);
			expect(result.rawMatch).toBe(false);
			expect(result.matches).toBe(true);
		});

		it('negates release_title regex match', () => {
			const condition = createCondition({
				type: 'release_title',
				pattern: 'CAM|TS|HDTS',
				negate: true
			});
			const release = createRelease({ title: 'Movie.2024.2160p.BluRay' });

			const result = evaluateCondition(condition, release);
			expect(result.matches).toBe(true); // Does NOT contain CAM/TS/HDTS
		});
	});

	// =========================================================================
	// Format Evaluation (Logic Tests)
	// =========================================================================
	describe('Format Evaluation', () => {
		describe('Required Conditions (AND logic)', () => {
			it('matches when all required conditions match', () => {
				const format = createFormat([
					createCondition({ type: 'resolution', resolution: '2160p', required: true }),
					createCondition({ type: 'source', source: 'bluray', required: true })
				]);
				const release = createRelease({ resolution: '2160p', source: 'bluray' });

				const { matches } = evaluateFormat(format, release);
				expect(matches).toBe(true);
			});

			it('does not match when one required condition fails', () => {
				const format = createFormat([
					createCondition({ type: 'resolution', resolution: '2160p', required: true }),
					createCondition({ type: 'source', source: 'webdl', required: true })
				]);
				const release = createRelease({ resolution: '2160p', source: 'bluray' });

				const { matches } = evaluateFormat(format, release);
				expect(matches).toBe(false);
			});
		});

		describe('Optional Conditions (OR logic)', () => {
			it('matches when at least one optional condition matches', () => {
				const format = createFormat([
					createCondition({ type: 'resolution', resolution: '2160p', required: true }),
					createCondition({ type: 'hdr', hdr: 'dolby-vision', required: false }),
					createCondition({ type: 'hdr', hdr: 'hdr10', required: false })
				]);
				const release = createRelease({ resolution: '2160p', hdr: 'dolby-vision' });

				const { matches } = evaluateFormat(format, release);
				expect(matches).toBe(true);
			});

			it('does not match when no optional conditions match', () => {
				const format = createFormat([
					createCondition({ type: 'resolution', resolution: '2160p', required: true }),
					createCondition({ type: 'hdr', hdr: 'dolby-vision', required: false }),
					createCondition({ type: 'hdr', hdr: 'hdr10', required: false })
				]);
				const release = createRelease({ resolution: '2160p', hdr: 'hlg' });

				const { matches } = evaluateFormat(format, release);
				expect(matches).toBe(false);
			});
		});

		describe('Combined Required + Optional', () => {
			it('fails if required fails even when optional matches', () => {
				const format = createFormat([
					createCondition({ type: 'resolution', resolution: '2160p', required: true }),
					createCondition({ type: 'hdr', hdr: 'dolby-vision', required: false })
				]);
				const release = createRelease({ resolution: '1080p', hdr: 'dolby-vision' });

				const { matches } = evaluateFormat(format, release);
				expect(matches).toBe(false);
			});

			it('matches with only required conditions (no optional)', () => {
				const format = createFormat([
					createCondition({ type: 'resolution', resolution: '2160p', required: true }),
					createCondition({ type: 'source', source: 'bluray', required: true })
				]);
				const release = createRelease({ resolution: '2160p', source: 'bluray' });

				const { matches } = evaluateFormat(format, release);
				expect(matches).toBe(true);
			});
		});
	});

	// =========================================================================
	// Format Matching
	// =========================================================================
	describe('language', () => {
		it('matches a language tag with base-tag fallback', () => {
			const condition = createCondition({ type: 'language', language: 'en' });
			const release = createRelease({ languages: ['eng'] });
			expect(evaluateCondition(condition, release).matches).toBe(true);
		});

		it('matches a region-tagged preference against a base token', () => {
			const condition = createCondition({ type: 'language', language: 'pt-BR' });
			const release = createRelease({ languages: ['pt'] });
			expect(evaluateCondition(condition, release).matches).toBe(true);
		});

		it('matches the multi pseudo-code', () => {
			const condition = createCondition({ type: 'language', language: 'multi' });
			expect(
				evaluateCondition(
					createCondition({ type: 'language', language: 'multi' }),
					createRelease({ languages: ['multi', 'fr'] })
				).matches
			).toBe(true);
			expect(evaluateCondition(condition, createRelease({ languages: ['fr'] })).matches).toBe(
				false
			);
		});

		it('does not match when the wanted language is absent', () => {
			const condition = createCondition({ type: 'language', language: 'es' });
			const release = createRelease({ languages: ['it', 'de'] });
			expect(evaluateCondition(condition, release).matches).toBe(false);
		});

		it('supports negation (must NOT match)', () => {
			const condition = createCondition({
				type: 'language',
				language: 'de',
				negate: true
			});
			const release = createRelease({ languages: ['de'] });
			expect(evaluateCondition(condition, release).matches).toBe(false);
		});
	});

	describe('matchFormats', () => {
		it('returns all matching formats', () => {
			const formats = [
				createFormat([createCondition({ type: 'resolution', resolution: '2160p' })], {
					id: 'format-1',
					name: '4K'
				}),
				createFormat([createCondition({ type: 'flag', flag: 'isRemux' })], {
					id: 'format-2',
					name: 'Remux'
				}),
				createFormat([createCondition({ type: 'resolution', resolution: '1080p' })], {
					id: 'format-3',
					name: '1080p'
				})
			];
			const release = createRelease({ resolution: '2160p', isRemux: true });

			const matched = matchFormats(release, formats);

			expect(matched.length).toBe(2);
			expect(matched.map((m) => m.format.id)).toContain('format-1');
			expect(matched.map((m) => m.format.id)).toContain('format-2');
		});

		it('returns empty array when nothing matches', () => {
			const formats = [
				createFormat([createCondition({ type: 'resolution', resolution: '480p' })], {
					id: 'format-1'
				})
			];
			const release = createRelease({ resolution: '2160p' });

			const matched = matchFormats(release, formats);
			expect(matched.length).toBe(0);
		});
	});

	describe('matchesFormat', () => {
		it('returns true when format matches', () => {
			const format = createFormat([createCondition({ type: 'resolution', resolution: '2160p' })]);
			const release = createRelease({ resolution: '2160p' });

			const matches = matchesFormat(release, format);
			expect(matches).toBe(true);
		});

		it('returns false when format does not match', () => {
			const format = createFormat([createCondition({ type: 'resolution', resolution: '2160p' })]);
			const release = createRelease({ resolution: '1080p' });

			const matches = matchesFormat(release, format);
			expect(matches).toBe(false);
		});
	});

	// =========================================================================
	// Edge Cases
	// =========================================================================
	describe('Edge Cases', () => {
		it('handles empty conditions array', () => {
			const format = createFormat([]);
			const release = createRelease();

			const { matches } = evaluateFormat(format, release);
			expect(matches).toBe(true); // No conditions = always matches
		});

		it('handles format with only optional conditions (none match)', () => {
			const format = createFormat([
				createCondition({ type: 'resolution', resolution: '480p', required: false }),
				createCondition({ type: 'resolution', resolution: '720p', required: false })
			]);
			const release = createRelease({ resolution: '2160p' });

			const { matches } = evaluateFormat(format, release);
			expect(matches).toBe(false);
		});

		it('handles format with only optional conditions (one matches)', () => {
			const format = createFormat([
				createCondition({ type: 'resolution', resolution: '480p', required: false }),
				createCondition({ type: 'resolution', resolution: '2160p', required: false })
			]);
			const release = createRelease({ resolution: '2160p' });

			const { matches } = evaluateFormat(format, release);
			expect(matches).toBe(true);
		});

		it('handles special regex characters in pattern', () => {
			const condition = createCondition({
				type: 'release_title',
				pattern: '\\[720p\\]'
			});
			const release = createRelease({ title: 'Movie [720p] BluRay' });

			const result = evaluateCondition(condition, release);
			expect(result.matches).toBe(true);
		});

		it('caches regex patterns for performance', () => {
			const condition = createCondition({
				type: 'release_title',
				pattern: 'CACHED_PATTERN'
			});

			// First call
			evaluateCondition(condition, createRelease({ title: 'CACHED_PATTERN' }));

			// Second call with same pattern should use cache
			const result = evaluateCondition(condition, createRelease({ title: 'CACHED_PATTERN' }));
			expect(result.matches).toBe(true);
		});
	});

	describe('Language attribute bridging (honest parser output)', () => {
		it('passes empty parsed languages through untouched', () => {
			// The parser yields [] for untagged releases (no English assertion);
			// the scoring bridge must preserve that instead of inventing values.
			const attrs = extractAttributes({
				originalTitle: 'Movie.2023.1080p.BluRay.x264-GROUP',
				cleanTitle: 'Movie',
				year: 2023,
				resolution: '1080p',
				source: 'bluray',
				codec: 'h264',
				hdr: null,
				audioCodec: 'unknown',
				audioChannels: 'unknown',
				hasAtmos: false,
				languages: [],
				isRemux: false,
				isRepack: false,
				isProper: false,
				is3d: false
			});

			expect(attrs.languages).toEqual([]);
		});

		it('passes the multi marker through without expanding it to English', () => {
			const attrs = extractAttributes({
				originalTitle: 'Movie.2023.MULTI.1080p.BluRay.x264-GROUP',
				cleanTitle: 'Movie',
				year: 2023,
				resolution: '1080p',
				source: 'bluray',
				codec: 'h264',
				hdr: null,
				audioCodec: 'unknown',
				audioChannels: 'unknown',
				hasAtmos: false,
				languages: ['multi'],
				isRemux: false,
				isRepack: false,
				isProper: false,
				is3d: false
			});

			expect(attrs.languages).toEqual(['multi']);
		});
	});
});
