import { describe, expect, it } from 'vitest';

import {
	grabRequestSchema,
	logDownloadQuerySchema,
	indexerUpdateSchema,
	nntpServerUpdateSchema,
	libraryUpdateSchema,
	rootFolderUpdateSchema,
	mediaBrowserServerUpdateSchema,
	mediaBrowserServerTestSchema,
	movieUpdateSchema,
	addMovieSchema
} from './schemas.js';
import { subtitleProviderUpdateSchema } from '#lib/server/validation/schemas.js';

describe('logDownloadQuerySchema', () => {
	it('accepts export requests up to the supported 5000 row cap', () => {
		const result = logDownloadQuerySchema.safeParse({
			limit: '5000',
			format: 'jsonl',
			levels: 'debug,info,warn,error'
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			return;
		}

		expect(result.data.limit).toBe(5000);
		expect(result.data.levels).toEqual(['debug', 'info', 'warn', 'error']);
		expect(result.data.format).toBe('jsonl');
	});

	it('rejects export requests above the supported 5000 row cap', () => {
		const result = logDownloadQuerySchema.safeParse({
			limit: '5001',
			format: 'jsonl'
		});

		expect(result.success).toBe(false);
	});
});

describe('grabRequestSchema', () => {
	const validMovieGrab = {
		title: 'Lone Survivor (2013) 1080p bluray x264',
		mediaType: 'movie' as const,
		downloadUrl: 'https://example.test/torrent/abc',
		movieId: 'movie-1',
		protocol: 'torrent' as const
	};

	it('accepts a valid movie grab', () => {
		const result = grabRequestSchema.safeParse(validMovieGrab);
		expect(result.success).toBe(true);
	});

	it('accepts a valid TV grab targeting a series', () => {
		const result = grabRequestSchema.safeParse({
			title: 'Futurama S06E17 1080p WEB-DL',
			mediaType: 'tv',
			magnetUrl: 'magnet:?xt=urn:btih:deadbeef',
			seriesId: 'series-1',
			seasonNumber: 6
		});
		expect(result.success).toBe(true);
	});

	it('ignores a legacy client "quality" object with null fields (e.g. SDR hdr: null)', () => {
		// Regression: SDR releases parse hdr as null. The unused quality field must never
		// break a grab again — it is stripped rather than validated.
		const result = grabRequestSchema.safeParse({
			...validMovieGrab,
			quality: { resolution: '1080p', source: 'bluray', codec: 'h264', hdr: null }
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).not.toHaveProperty('quality');
		}
	});

	it('requires a download source (downloadUrl or magnetUrl)', () => {
		const { downloadUrl: _downloadUrl, ...noSource } = validMovieGrab;
		const result = grabRequestSchema.safeParse(noSource);
		expect(result.success).toBe(false);
	});

	it('requires a media target (movieId or seriesId)', () => {
		const { movieId: _movieId, ...noTarget } = validMovieGrab;
		const result = grabRequestSchema.safeParse(noTarget);
		expect(result.success).toBe(false);
	});
});

describe('update schemas do not backfill defaults', () => {
	// Regression: Zod 4 `.partial()` fills missing keys with their `.default()`
	// values, which causes PATCH/update payloads to overwrite existing config
	// with defaults. The update schemas use `.required().partial()` to strip
	// defaults first, so absent keys stay absent. See zod issue #5235.
	type Parsable = {
		safeParse: (input: unknown) => { success: boolean; data?: unknown };
	};

	function expectOnlyProvidedKeys(schema: Parsable, input: Record<string, unknown>) {
		const result = schema.safeParse(input);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(Object.keys(result.data as Record<string, unknown>)).toEqual(Object.keys(input));
	}

	it('indexerUpdateSchema omits defaulted fields when only `enabled` is sent', () => {
		const result = indexerUpdateSchema.safeParse({ enabled: false });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ enabled: false });
		expect(result.data).not.toHaveProperty('priority');
		expect(result.data).not.toHaveProperty('alternateUrls');
		expect(result.data).not.toHaveProperty('minimumSeeders');
		expect(result.data).not.toHaveProperty('enableAutomaticSearch');
	});

	it('indexerUpdateSchema preserves provided fields and explicit nulls', () => {
		const result = indexerUpdateSchema.safeParse({ priority: 3, seedRatio: null });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({ priority: 3, seedRatio: null });
	});

	it('indexerUpdateSchema parse({}) yields an empty object', () => {
		const result = indexerUpdateSchema.safeParse({});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({});
	});

	it.each([
		['indexerUpdateSchema', indexerUpdateSchema, { enabled: false }],
		['subtitleProviderUpdateSchema', subtitleProviderUpdateSchema, { enabled: false }],
		['nntpServerUpdateSchema', nntpServerUpdateSchema, { enabled: false }],
		['libraryUpdateSchema', libraryUpdateSchema, { isDefault: false }],
		['rootFolderUpdateSchema', rootFolderUpdateSchema, { isDefault: false }],
		['mediaBrowserServerUpdateSchema', mediaBrowserServerUpdateSchema, { enabled: false }]
	])('%s does not synthesize defaults for absent keys', (_name, schema, input) => {
		expectOnlyProvidedKeys(schema as Parsable, input as Record<string, unknown>);
	});

	it('mediaBrowserServerTestSchema.partial() omits serverType when the body is empty', () => {
		const result = mediaBrowserServerTestSchema.partial().safeParse({});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual({});
	});
});

describe('mediaBrowserServerTestSchema', () => {
	it('does not backfill serverType, so a saved Plex/Emby server is not tested as jellyfin', () => {
		const result = mediaBrowserServerTestSchema.safeParse({
			host: 'http://plex.test',
			apiKey: 'key'
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.serverType).toBeUndefined();
	});

	it('still requires host and apiKey for the pre-save test endpoint', () => {
		expect(mediaBrowserServerTestSchema.safeParse({}).success).toBe(false);
		expect(mediaBrowserServerTestSchema.safeParse({ host: 'http://plex.test' }).success).toBe(
			false
		);
		expect(mediaBrowserServerTestSchema.safeParse({ apiKey: 'key' }).success).toBe(false);
	});

	it('accepts an explicit serverType', () => {
		const result = mediaBrowserServerTestSchema.safeParse({
			host: 'http://plex.test',
			apiKey: 'key',
			serverType: 'plex'
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.serverType).toBe('plex');
	});
});

describe('movie desiredQualities', () => {
	it('movieUpdateSchema accepts a valid resolution array', () => {
		const result = movieUpdateSchema.safeParse({ desiredQualities: ['2160p', '1080p'] });
		expect(result.success).toBe(true);
	});

	it('movieUpdateSchema accepts null (opt out of multi-quality)', () => {
		const result = movieUpdateSchema.safeParse({ desiredQualities: null });
		expect(result.success).toBe(true);
	});

	it('movieUpdateSchema rejects unsupported resolutions', () => {
		const result = movieUpdateSchema.safeParse({ desiredQualities: ['1440p'] });
		expect(result.success).toBe(false);
	});

	it('addMovieSchema accepts desiredQualities', () => {
		const result = addMovieSchema.safeParse({
			tmdbId: 1,
			rootFolderId: 'rf-1',
			desiredQualities: ['2160p', '1080p', '720p']
		});
		expect(result.success).toBe(true);
	});
});
