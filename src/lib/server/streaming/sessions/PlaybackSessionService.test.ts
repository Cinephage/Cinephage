import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../../../../test/db-helper';
import { eq } from 'drizzle-orm';
import { languageProfiles, movies, series } from '#lib/server/db/schema.js';
import type { StreamSource } from '../types';

/**
 * Real integration over an in-memory database: the language-profile-helper
 * resolves preferences through the actual LanguageProfileService against
 * seeded movies/series/profiles rows (no coarse helper mock).
 */
const testDb: TestDatabase = createTestDb();

/** When true, every access to the mocked db throws (helper must never propagate). */
let failDbLookups = false;

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		if (failDbLookups) {
			throw new Error('db unavailable');
		}
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const getStreamsMock = vi.fn();

vi.mock('#lib/server/cinephage/modules/library-streaming/LibraryStreamingModule.js', () => ({
	getLibraryStreamingModule: () => ({
		getStreams: getStreamsMock
	})
}));

const NO_PROFILE_DEFAULT = {
	preferOriginal: true,
	languages: [],
	originalLanguage: null,
	mode: 'prefer'
};

let mediaSeq = 0;

function seedMovie(
	tmdbId: number,
	options: { originalLanguage?: string; languageProfileId?: string } = {}
): void {
	mediaSeq += 1;
	testDb.db
		.insert(movies)
		.values({
			id: `movie-${tmdbId}`,
			tmdbId,
			title: `Movie ${tmdbId}`,
			path: `movie-${tmdbId}-${mediaSeq}`,
			originalLanguage: options.originalLanguage ?? null,
			languageProfileId: options.languageProfileId ?? null
		})
		.run();
}

function seedSeries(
	tmdbId: number,
	options: { originalLanguage?: string; languageProfileId?: string } = {}
): void {
	mediaSeq += 1;
	testDb.db
		.insert(series)
		.values({
			id: `series-${tmdbId}`,
			tmdbId,
			title: `Series ${tmdbId}`,
			path: `series-${tmdbId}-${mediaSeq}`,
			originalLanguage: options.originalLanguage ?? null,
			languageProfileId: options.languageProfileId ?? null
		})
		.run();
}

function seedProfile(
	id: string,
	audio: { preferOriginal?: boolean; languages?: string[] } = {}
): void {
	testDb.db
		.insert(languageProfiles)
		.values({
			id,
			name: `Profile ${id}`,
			audio: {
				preferOriginal: audio.preferOriginal ?? true,
				languages: audio.languages ?? [],
				mode: 'prefer'
			},
			subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
			cutoffRank: null,
			minimumScore: 70,
			upgradesAllowed: true
		})
		.run();
}

function updateProfileAudio(
	id: string,
	audio: { preferOriginal?: boolean; languages?: string[] }
): void {
	testDb.db
		.update(languageProfiles)
		.set({
			audio: {
				preferOriginal: audio.preferOriginal ?? true,
				languages: audio.languages ?? [],
				mode: 'prefer'
			}
		})
		.where(eq(languageProfiles.id, id))
		.run();
}

function makeSource(url: string, language?: string): StreamSource {
	return {
		quality: '1080p',
		title: 'Test stream',
		url,
		type: 'mp4',
		referer: 'https://player.example.com/',
		requiresSegmentProxy: false,
		provider: 'Mapple',
		language
	};
}

function mockStreams(...sources: StreamSource[]): void {
	getStreamsMock.mockResolvedValue({
		success: true,
		sources,
		meta: {}
	});
}

describe('PlaybackSessionService', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		failDbLookups = false;
		for (const table of [languageProfiles, movies, series]) {
			testDb.db.delete(table).run();
		}
		const { getPlaybackSessionStore } = await import('./session-store');
		getPlaybackSessionStore().clear();
	});

	it('creates a reusable playback session for a movie source', async () => {
		mockStreams(
			makeSource('https://stream.example.com/direct.mp4'),
			makeSource('https://stream.example.com/alt.mp4', 'fr')
		);

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('direct.mp4')) {
				return new Response(new Uint8Array([0x47, 0x40, 0x11]), {
					status: 200,
					headers: { 'Content-Type': 'video/mp4' }
				});
			}
			return new Response(new Uint8Array([0x47, 0x40, 0x11]), {
				status: 404
			});
		});

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({ tmdbId: 550, type: 'movie' });
		expect(first.session).toBeTruthy();
		expect(first.session?.provider).toBe('Mapple');

		const second = await service.createOrReuseSession({ tmdbId: 550, type: 'movie' });
		expect(second.session?.token).toBe(first.session?.token);
		expect(getStreamsMock).toHaveBeenCalledTimes(1);
	});

	it('uses the default audio preference and upstream order when the media has no profile', async () => {
		// No movie row at all: preference resolves to the no-profile default and
		// the stable sort keeps the upstream order within the neutral buckets.
		mockStreams(
			makeSource('https://stream.example.com/fr.mp4', 'fr'),
			makeSource('https://stream.example.com/en.mp4', 'en')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const { session } = await service.createOrReuseSession({ tmdbId: 42, type: 'movie' });
		expect(session?.audioPreference).toEqual(NO_PROFILE_DEFAULT);
		// Both sources are "other"-tagged under the default preference, so the
		// first upstream source wins.
		expect(session?.entryUrl).toBe('https://stream.example.com/fr.mp4');
		expect(session?.chosenAudioLanguage).toBe('fr');
	});

	it('prefers sources matching the persisted original language, incl. alpha-3 tags', async () => {
		// Persisted ja original; the eng-tagged source must NOT match while a
		// jpn-tagged one must (ISO 639-2 → base-tag normalization).
		seedMovie(201, { originalLanguage: 'ja' });
		mockStreams(
			makeSource('https://stream.example.com/eng.mp4', 'eng'),
			makeSource('https://stream.example.com/jpn.mp4', 'jpn')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const { session } = await service.createOrReuseSession({ tmdbId: 201, type: 'movie' });
		expect(session?.audioPreference).toEqual({
			preferOriginal: true,
			languages: [],
			originalLanguage: 'ja',
			mode: 'prefer'
		});
		expect(session?.entryUrl).toBe('https://stream.example.com/jpn.mp4');
		expect(session?.chosenAudioLanguage).toBe('jpn');
	});

	it('ranks profile fallback languages in preference order (pt-BR before fr)', async () => {
		seedProfile('p-br', { languages: ['pt-BR', 'fr'] });
		seedMovie(301, { originalLanguage: 'en', languageProfileId: 'p-br' });

		// No en source available: pt-BR outranks fr, unknown de comes last.
		mockStreams(
			makeSource('https://stream.example.com/fr.mp4', 'fr'),
			makeSource('https://stream.example.com/de.mp4', 'de'),
			makeSource('https://stream.example.com/ptbr.mp4', 'pt-BR')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({ tmdbId: 301, type: 'movie' });
		expect(first.session?.entryUrl).toBe('https://stream.example.com/ptbr.mp4');
		expect(first.session?.chosenAudioLanguage).toBe('pt-BR');

		// With the top preference absent, the second entry wins.
		mockStreams(
			makeSource('https://stream.example.com/fr.mp4', 'fr'),
			makeSource('https://stream.example.com/de.mp4', 'de')
		);
		const second = await service.createOrReuseSession({
			tmdbId: 301,
			type: 'movie',
			forceRefresh: true
		});
		expect(second.session?.entryUrl).toBe('https://stream.example.com/fr.mp4');
	});

	it('lets the original language win over profile fallback languages', async () => {
		seedProfile('p-br2', { languages: ['pt-BR', 'fr'] });
		seedMovie(311, { originalLanguage: 'en', languageProfileId: 'p-br2' });
		mockStreams(
			makeSource('https://stream.example.com/ptbr.mp4', 'pt-BR'),
			makeSource('https://stream.example.com/en.mp4', 'en')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const { session } = await service.createOrReuseSession({ tmdbId: 311, type: 'movie' });
		expect(session?.entryUrl).toBe('https://stream.example.com/en.mp4');
		expect(session?.chosenAudioLanguage).toBe('en');
	});

	it('treats language-less sources as neutral and ranks unknown languages last', async () => {
		seedProfile('p-fr', { languages: ['fr'] });
		seedMovie(401, { languageProfileId: 'p-fr' });

		// Untagged source is neutral (bucket 2) while de is known-foreign (bucket 3).
		mockStreams(
			makeSource('https://stream.example.com/de.mp4', 'de'),
			makeSource('https://stream.example.com/untagged.mp4')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const { session } = await service.createOrReuseSession({ tmdbId: 401, type: 'movie' });
		expect(session?.entryUrl).toBe('https://stream.example.com/untagged.mp4');
		// Nothing recorded: the pick was a neutral fallback, not a language match.
		expect(session?.chosenAudioLanguage).toBeNull();
	});

	it('ignores the original language when the profile disables preferOriginal', async () => {
		seedProfile('p-nopref', { preferOriginal: false, languages: ['fr'] });
		seedMovie(501, { originalLanguage: 'ja', languageProfileId: 'p-nopref' });
		mockStreams(
			makeSource('https://stream.example.com/ja.mp4', 'ja'),
			makeSource('https://stream.example.com/fr.mp4', 'fr')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const { session } = await service.createOrReuseSession({ tmdbId: 501, type: 'movie' });
		expect(session?.audioPreference).toEqual({
			preferOriginal: false,
			languages: ['fr'],
			originalLanguage: 'ja',
			mode: 'prefer'
		});
		expect(session?.entryUrl).toBe('https://stream.example.com/fr.mp4');
	});

	it('resolves series preferences through the persisted series original language', async () => {
		seedSeries(700, { originalLanguage: 'ko' });
		mockStreams(
			makeSource('https://stream.example.com/en.mp4', 'en'),
			makeSource('https://stream.example.com/ko.mp4', 'ko')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({
			tmdbId: 700,
			type: 'tv',
			season: 1,
			episode: 2
		});
		expect(first.session?.entryUrl).toBe('https://stream.example.com/ko.mp4');
		expect(first.session?.chosenAudioLanguage).toBe('ko');
		expect(first.session?.audioPreference).toEqual({
			preferOriginal: true,
			languages: [],
			originalLanguage: 'ko',
			mode: 'prefer'
		});

		const second = await service.createOrReuseSession({
			tmdbId: 700,
			type: 'tv',
			season: 1,
			episode: 2
		});
		expect(second.session?.token).toBe(first.session?.token);
		expect(getStreamsMock).toHaveBeenCalledTimes(1);
	});

	it('blocks session reuse when the resolved audio preference changed', async () => {
		seedProfile('p-change', { languages: ['ja'] });
		seedMovie(101, { languageProfileId: 'p-change' });

		mockStreams(makeSource('https://stream.example.com/ja.mp4', 'ja'));

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({ tmdbId: 101, type: 'movie' });
		expect(first.session?.audioPreference).toEqual({
			preferOriginal: true,
			languages: ['ja'],
			originalLanguage: null,
			mode: 'prefer'
		});

		// The profile changes (e.g. user edits it); no forceRefresh is passed.
		updateProfileAudio('p-change', { languages: ['fr'] });
		mockStreams(makeSource('https://stream.example.com/fr.mp4', 'fr'));

		const second = await service.createOrReuseSession({ tmdbId: 101, type: 'movie' });
		expect(second.session?.token).not.toBe(first.session?.token);
		expect(getStreamsMock).toHaveBeenCalledTimes(2);
		expect(second.session?.audioPreference).toEqual({
			preferOriginal: true,
			languages: ['fr'],
			originalLanguage: null,
			mode: 'prefer'
		});
	});

	it('reuses the session when the resolved audio preference is unchanged', async () => {
		seedProfile('p-same', { languages: ['ja'] });
		seedMovie(111, { originalLanguage: 'ja', languageProfileId: 'p-same' });

		mockStreams(makeSource('https://stream.example.com/ja.mp4', 'ja'));

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({ tmdbId: 111, type: 'movie' });
		const second = await service.createOrReuseSession({ tmdbId: 111, type: 'movie' });

		expect(second.session?.token).toBe(first.session?.token);
		expect(getStreamsMock).toHaveBeenCalledTimes(1);
	});

	it('reuses pre-deploy sessions without a snapshot only under the default preference', async () => {
		const { getPlaybackSessionStore } = await import('./session-store');
		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();
		const store = getPlaybackSessionStore();

		// Session created before audio preference existed: no stored snapshot.
		const legacyDefault = store.createSession({
			mediaType: 'movie',
			tmdbId: 999,
			entryUrl: 'https://stream.example.com/legacy.mp4',
			sourceType: 'mp4',
			requestHeaders: {},
			attempts: []
		});

		// Media not in the library → current preference is the no-profile default.
		const reused = await service.createOrReuseSession({ tmdbId: 999, type: 'movie' });
		expect(reused.session?.token).toBe(legacyDefault.token);
		expect(getStreamsMock).not.toHaveBeenCalled();

		// Now a media whose resolved preference is NOT the default…
		seedMovie(555, { originalLanguage: 'ja' });
		const legacyJa = store.createSession({
			mediaType: 'movie',
			tmdbId: 555,
			entryUrl: 'https://stream.example.com/legacy-ja.mp4',
			sourceType: 'mp4',
			requestHeaders: {},
			attempts: []
		});

		mockStreams(makeSource('https://stream.example.com/ja.mp4', 'ja'));

		// …so the snapshot-less session must NOT be reused.
		const notReused = await service.createOrReuseSession({ tmdbId: 555, type: 'movie' });
		expect(notReused.session?.token).not.toBe(legacyJa.token);
		expect(notReused.session?.entryUrl).toBe('https://stream.example.com/ja.mp4');
		expect(getStreamsMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to the default preference (and never throws) when the lookup fails', async () => {
		mockStreams(
			makeSource('https://stream.example.com/fr.mp4', 'fr'),
			makeSource('https://stream.example.com/en.mp4', 'en')
		);

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		failDbLookups = true;
		try {
			const { session } = await service.createOrReuseSession({ tmdbId: 42, type: 'movie' });
			expect(session).toBeTruthy();
			expect(session?.audioPreference).toEqual(NO_PROFILE_DEFAULT);
			expect(session?.entryUrl).toBe('https://stream.example.com/fr.mp4');
		} finally {
			failDbLookups = false;
		}
	});

	it('builds subtitle playlists that point at the session subtitle route', async () => {
		const { getPlaybackSessionStore } = await import('./session-store');
		const { getSessionProxyService } = await import('./SessionProxyService');

		const session = getPlaybackSessionStore().createSession({
			mediaType: 'movie',
			tmdbId: 550,
			entryUrl: 'https://stream.example.com/master.m3u8',
			sourceType: 'hls',
			requestHeaders: { Referer: 'https://player.example.com/' },
			subtitles: [
				{
					id: 'sub-0',
					url: 'https://stream.example.com/subtitles/en.srt',
					label: 'English',
					language: 'en'
				}
			],
			attempts: []
		});

		const response = await getSessionProxyService().renderSubtitlePlaylist(
			session,
			'sub-0',
			'https://media.example.com',
			'api-key'
		);

		const playlist = await response.text();
		expect(playlist).toContain(
			'https://media.example.com/api/streaming/session/' +
				session.token +
				'/subtitle/sub-0.vtt?api_key=api-key'
		);
	});

	it('does not start stream lookup when session creation is already aborted', async () => {
		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const controller = new AbortController();
		controller.abort();

		const result = await service.createOrReuseSession({
			tmdbId: 550,
			type: 'movie',
			signal: controller.signal
		});

		expect(result.session).toBeNull();
		expect(result.error).toBe('Aborted');
		expect(getStreamsMock).not.toHaveBeenCalled();
	});

	it('re-resolves when the reused session source URL has expired', async () => {
		// Computed once and reused below: calling Date.now() again at the
		// assertion (rather than reusing this value) raced a real second
		// boundary under CI's slower/loaded scheduler, flaking by ±1s.
		const expiresAt = Math.floor(Date.now() / 1000) + 60;
		getStreamsMock.mockResolvedValue({
			success: true,
			sources: [
				{
					quality: '1080p',
					title: 'Test stream',
					url: 'https://stream.example.com/master.m3u8',
					type: 'hls',
					referer: 'https://player.example.com/',
					requiresSegmentProxy: true,
					provider: 'Vidlink',
					expiresAt
				}
			]
		});

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({ tmdbId: 550, type: 'movie' });
		expect(first.session).toBeTruthy();
		expect(first.session?.sourceExpiresAt).toBe(expiresAt);

		// Simulate the source URL expiring while the session TTL is still valid.
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120 * 1000);

		const second = await service.createOrReuseSession({ tmdbId: 550, type: 'movie' });
		expect(second.session?.token).not.toBe(first.session?.token);
		expect(getStreamsMock).toHaveBeenCalledTimes(2);

		vi.restoreAllMocks();
	});

	it('forces a fresh resolve and passes refresh to the lookup when forceRefresh is set', async () => {
		mockStreams(makeSource('https://stream.example.com/direct.mp4'));

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const first = await service.createOrReuseSession({ tmdbId: 550, type: 'movie' });
		expect(first.session).toBeTruthy();

		const second = await service.createOrReuseSession({
			tmdbId: 550,
			type: 'movie',
			forceRefresh: true
		});

		// The cached session is skipped and the gateway is told to bypass its cache.
		expect(second.session?.token).not.toBe(first.session?.token);
		expect(getStreamsMock).toHaveBeenCalledTimes(2);
		expect(getStreamsMock).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
	});

	it('omits the Referer header when a source carries an explicit empty referer', async () => {
		getStreamsMock.mockResolvedValue({
			success: true,
			sources: [
				{
					quality: '1080p',
					title: 'Test stream',
					url: 'https://stream.example.com/direct.mp4',
					type: 'mp4',
					referer: '',
					requiresSegmentProxy: false,
					provider: 'Vidlink',
					headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' }
				}
			]
		});

		const { getPlaybackSessionService } = await import('./PlaybackSessionService');
		const service = getPlaybackSessionService();

		const { session } = await service.createOrReuseSession({ tmdbId: 550, type: 'movie' });
		expect(session).toBeTruthy();
		expect(session?.requestHeaders['User-Agent']).toBe('VLC/3.0.20 LibVLC/3.0.20');
		expect(session?.requestHeaders['Referer']).toBeUndefined();
		expect(session?.requestHeaders['referer']).toBeUndefined();
	});
});
