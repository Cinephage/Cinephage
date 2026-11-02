import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackSessionStore } from './session-store';
import { DEFAULT_EFFECTIVE_AUDIO_PREFERENCE } from '../language-utils';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

function createStore(): PlaybackSessionStore {
	return new PlaybackSessionStore();
}

function createSession(
	store: PlaybackSessionStore,
	requirements?: SubtitleRequirement[]
): ReturnType<PlaybackSessionStore['createSession']> {
	return store.createSession({
		mediaType: 'movie',
		tmdbId: 1,
		entryUrl: 'https://cdn.example.com/master.m3u8',
		sourceType: 'hls',
		requestHeaders: {},
		attempts: [],
		preferredSubtitleRequirements: requirements
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe('PlaybackSessionStore TTL', () => {
	it('slides the expiry on access and enforces the hard cap from creation', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const store = createStore();
		const session = createSession(store);
		const initialExpiry = session.expiresAt;

		// 29 minutes later: still live, and accessing it extends the window.
		vi.advanceTimersByTime(29 * 60 * 1000);
		expect(store.getSession(session.token)).not.toBeNull();
		expect(session.expiresAt).toBeGreaterThan(initialExpiry);

		// Beyond the hard cap (6h from creation) it must expire even though it
		// was being accessed continuously.
		vi.advanceTimersByTime(6 * 60 * 60 * 1000);
		expect(store.getSession(session.token)).toBeNull();
	});

	it('expires an idle session after the 30-minute window', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const store = createStore();
		const session = createSession(store);

		vi.advanceTimersByTime(31 * 60 * 1000);
		expect(store.getSession(session.token)).toBeNull();
	});
});

describe('PlaybackSessionStore subtitle requirement reuse', () => {
	const requirement: SubtitleRequirement = {
		tag: 'en',
		variant: 'regular',
		accessibility: 'any'
	};
	const other: SubtitleRequirement = { tag: 'fr', variant: 'regular', accessibility: 'any' };

	it('reuses a session when the requirement snapshot is unchanged', () => {
		const store = createStore();
		const session = createSession(store, [requirement]);

		const reusable = store.findReusableSession(
			'movie',
			1,
			undefined,
			undefined,
			DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
			[requirement]
		);
		expect(reusable?.token).toBe(session.token);
	});

	it('does not reuse when the requirements changed or were added', () => {
		const store = createStore();
		createSession(store, [requirement]);

		expect(
			store.findReusableSession(
				'movie',
				1,
				undefined,
				undefined,
				DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
				[other]
			)
		).toBeNull();

		const store2 = createStore();
		createSession(store2, []);
		expect(
			store2.findReusableSession(
				'movie',
				1,
				undefined,
				undefined,
				DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
				[requirement]
			)
		).toBeNull();
	});
});
