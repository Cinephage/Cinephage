import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const buildMetadataProviderRegistryMock = vi.fn();

vi.mock('./provider-registry.js', () => ({
	buildMetadataProviderRegistry: buildMetadataProviderRegistryMock
}));

// Imported after the mock is registered so resolveMissingAnimeProviderRefs
// picks up the mocked provider registry.
const { resolveMissingAnimeProviderRefs } = await import('./provider-ref-resolver.js');

function makeProvider(searchTitle: () => Promise<{ id: string; title: string }[]>) {
	return { isConfigured: () => true, searchTitle };
}

describe('resolveMissingAnimeProviderRefs', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not hang forever on a provider that never responds', async () => {
		// Regression test: a stalled upstream (AniList/Jikan) used to block the
		// series page's SSR load indefinitely. A provider whose searchTitle
		// never resolves must still let resolveMissingAnimeProviderRefs settle
		// once the internal per-provider timeout elapses.
		const neverResolves = makeProvider(() => new Promise(() => {}));
		buildMetadataProviderRegistryMock.mockResolvedValue({
			providers: new Map([['anilist', neverResolves]])
		});

		const resultPromise = resolveMissingAnimeProviderRefs({
			title: 'Some Anime',
			isAnime: true,
			configured: { anilist: true, mal: false }
		});

		// Advance past the 8s per-provider timeout in provider-ref-resolver.ts.
		await vi.advanceTimersByTimeAsync(8100);

		const result = await resultPromise;
		expect(result.anilist).toBeUndefined();
	});

	it('resolves normally when the provider responds quickly', async () => {
		const quick = makeProvider(async () => [{ id: '42', title: 'Some Anime' }]);
		buildMetadataProviderRegistryMock.mockResolvedValue({
			providers: new Map([['anilist', quick]])
		});

		const result = await resolveMissingAnimeProviderRefs({
			title: 'Some Anime',
			isAnime: true,
			configured: { anilist: true, mal: false }
		});

		expect(result.anilist).toBe('42');
	});

	it('skips non-anime content entirely', async () => {
		buildMetadataProviderRegistryMock.mockResolvedValue({ providers: new Map() });

		const result = await resolveMissingAnimeProviderRefs({
			title: 'Some Show',
			isAnime: false,
			configured: { anilist: true, mal: true }
		});

		expect(result).toEqual({});
		expect(buildMetadataProviderRegistryMock).not.toHaveBeenCalled();
	});

	it("matches via the candidate's native/original title even when the English title differs", async () => {
		// Real-world case: our stored title has no leading "The", MAL's
		// title_english does ("The Afterglow Of Zeon"). The native Japanese
		// title is identical on both sides and should be trusted on its own.
		const provider = makeProvider(async () => [
			{
				id: '906',
				title: 'Mobile Suit Gundam 0083: The Afterglow Of Zeon',
				originalTitle: '機動戦士ガンダム0083 ジオンの残光',
				year: 1992
			}
		]);
		buildMetadataProviderRegistryMock.mockResolvedValue({
			providers: new Map([['mal', provider]])
		});

		const result = await resolveMissingAnimeProviderRefs({
			title: 'Mobile Suit Gundam 0083: Afterglow of Zeon',
			aliases: ['機動戦士ガンダム0083 ジオンの残光'],
			year: 1992,
			isAnime: true,
			configured: { anilist: false, mal: true }
		});

		expect(result.mal).toBe('906');
	});

	it('does not treat two different anime as a match just because their native titles share a number', async () => {
		// Regression guard for the Unicode-normalize fix: a naive ASCII-only
		// character filter strips all Japanese text down to whatever digits
		// survive, which would make any two titles sharing a number (here,
		// "0083") look identical regardless of the actual Japanese text.
		const provider = makeProvider(async () => [
			{
				id: '999',
				title: 'Some Unrelated Show 0083',
				originalTitle: '全く関係のない別の作品0083',
				year: 1992
			}
		]);
		buildMetadataProviderRegistryMock.mockResolvedValue({
			providers: new Map([['mal', provider]])
		});

		const result = await resolveMissingAnimeProviderRefs({
			title: 'Mobile Suit Gundam 0083: Afterglow of Zeon',
			aliases: ['機動戦士ガンダム0083 ジオンの残光'],
			year: 1992,
			isAnime: true,
			configured: { anilist: false, mal: true }
		});

		expect(result.mal).toBeUndefined();
	});
});
