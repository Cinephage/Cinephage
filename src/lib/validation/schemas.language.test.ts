import { describe, expect, it } from 'vitest';
import {
	audioPreferenceSchema,
	episodeUpdateSchema,
	languageProfileV2CreateSchema,
	languageProfileV2UpdateSchema,
	movieUpdateSchema,
	seriesUpdateSchema,
	subtitleRequirementSchema,
	subtitleRequirementsOverrideSchema
} from './schemas.js';

describe('subtitleRequirementSchema', () => {
	it('canonicalizes tags and applies defaults', () => {
		const parsed = subtitleRequirementSchema.parse({ tag: 'POB' });
		expect(parsed).toEqual({ tag: 'pt-BR', variant: 'regular', accessibility: 'any' });
	});

	it('rejects unknown language codes', () => {
		expect(() => subtitleRequirementSchema.parse({ tag: 'xx' })).toThrow();
	});
});

describe('audioPreferenceSchema', () => {
	it('defaults to original audio with no fallbacks', () => {
		expect(audioPreferenceSchema.parse({})).toEqual({
			preferOriginal: true,
			languages: [],
			mode: 'prefer',
			requireAll: false
		});
	});

	it('canonicalizes fallback languages', () => {
		expect(audioPreferenceSchema.parse({ languages: ['FRE', 'ger'] })).toEqual({
			preferOriginal: true,
			languages: ['fr', 'de'],
			mode: 'prefer',
			requireAll: false
		});
	});
});

describe('languageProfileV2CreateSchema', () => {
	const validBody = {
		name: 'Anime',
		subtitles: [{ tag: 'ja' }, { tag: 'en', variant: 'forced' }]
	};

	it('accepts a valid profile and applies defaults', () => {
		const parsed = languageProfileV2CreateSchema.parse(validBody);
		expect(parsed.minimumScore).toBe(70);
		expect(parsed.cutoffRank).toBeNull();
		expect(parsed.subtitles[0]).toEqual({ tag: 'ja', variant: 'regular', accessibility: 'any' });
	});

	it('rejects a cutoff rank outside the requirement list', () => {
		expect(() => languageProfileV2CreateSchema.parse({ ...validBody, cutoffRank: 2 })).toThrow();
	});

	it('accepts a cutoff rank on the last requirement', () => {
		const parsed = languageProfileV2CreateSchema.parse({ ...validBody, cutoffRank: 1 });
		expect(parsed.cutoffRank).toBe(1);
	});

	it('rejects duplicate requirement tuples', () => {
		expect(() =>
			languageProfileV2CreateSchema.parse({
				name: 'Dupes',
				subtitles: [{ tag: 'en' }, { tag: 'eng' }]
			})
		).toThrow();
	});

	it('clamps the score scale to 0-100', () => {
		expect(() =>
			languageProfileV2CreateSchema.parse({ ...validBody, minimumScore: 360 })
		).toThrow();
	});
});

describe('languageProfileV2UpdateSchema', () => {
	it('accepts partial updates', () => {
		expect(languageProfileV2UpdateSchema.parse({ minimumScore: 50 })).toMatchObject({
			minimumScore: 50
		});
	});

	it('does not materialize defaults for absent fields (rename-only update)', () => {
		expect(languageProfileV2UpdateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
	});

	it('parses an empty object to an empty patch', () => {
		expect(languageProfileV2UpdateSchema.parse({})).toEqual({});
	});
});

describe('subtitleRequirementsOverrideSchema', () => {
	it('canonicalizes tags and applies requirement defaults', () => {
		expect(subtitleRequirementsOverrideSchema.parse([{ tag: 'FRE' }])).toEqual([
			{ tag: 'fr', variant: 'regular', accessibility: 'any' }
		]);
	});

	it('rejects an empty override (use the wants-subtitles gate instead)', () => {
		expect(() => subtitleRequirementsOverrideSchema.parse([])).toThrow();
	});

	it('rejects more than 10 requirements', () => {
		const requirements = Array.from({ length: 11 }, (_, i) => ({
			tag: ['en', 'fr', 'de', 'ja', 'es', 'it', 'pt', 'ru', 'ko', 'zh', 'nl'][i]
		}));
		expect(() => subtitleRequirementsOverrideSchema.parse(requirements)).toThrow();
	});

	it('rejects duplicate requirement tuples', () => {
		expect(() =>
			subtitleRequirementsOverrideSchema.parse([{ tag: 'en' }, { tag: 'eng' }])
		).toThrow();
	});

	it('rejects unknown language codes', () => {
		expect(() => subtitleRequirementsOverrideSchema.parse([{ tag: 'qq' }])).toThrow();
	});
});

describe('per-item override fields in update schemas', () => {
	it('episode: accepts an override and null to clear', () => {
		expect(
			episodeUpdateSchema.parse({ subtitleRequirementsOverride: [{ tag: 'ja' }] })
		).toMatchObject({
			subtitleRequirementsOverride: [{ tag: 'ja', variant: 'regular', accessibility: 'any' }]
		});
		expect(episodeUpdateSchema.parse({ subtitleRequirementsOverride: null })).toMatchObject({
			subtitleRequirementsOverride: null
		});
	});

	it('episode: rejects an empty override list', () => {
		expect(() => episodeUpdateSchema.parse({ subtitleRequirementsOverride: [] })).toThrow();
	});

	it('episode: still requires at least one field', () => {
		expect(() => episodeUpdateSchema.parse({})).toThrow();
	});

	it('movie and series accept nullable overrides', () => {
		const payload = { subtitleRequirementsOverride: [{ tag: 'de', variant: 'both' }] };
		expect(movieUpdateSchema.parse(payload)).toMatchObject({
			subtitleRequirementsOverride: [{ tag: 'de', variant: 'both', accessibility: 'any' }]
		});
		expect(seriesUpdateSchema.parse({ subtitleRequirementsOverride: null })).toMatchObject({
			subtitleRequirementsOverride: null
		});
	});
});
