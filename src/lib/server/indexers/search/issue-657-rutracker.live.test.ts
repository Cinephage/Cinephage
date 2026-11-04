/**
 * Live regression test for issue #657: automatic TV searches against
 * RuTracker appended Sxx tokens to the text query (`nm=Озарк%S04`) and the
 * tracker returned 0 rows — only interactive search found packs, via its
 * title-only fallback. Automatic searches now also fall back to the bare
 * title, and the RuTracker automatic episode path queries title-only.
 *
 * Requires a configured, enabled RuTracker.org indexer with working
 * credentials and network access to the tracker (Cloudflare browser bypass
 * included). Stays out of the normal suite; run with:
 *
 *   LIVE_TESTS=true npx vitest run src/lib/server/indexers/search/issue-657-rutracker.live.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getIndexerManager } from '../IndexerManager.js';
import { captchaSolverSettingsService, getCaptchaSolver } from '#lib/server/captcha/index.js';
import { getCamoufoxManager } from '#lib/server/captcha/browser/CamoufoxManager.js';
import type { EnhancedReleaseResult, TvSearchCriteria } from '../types/index.js';

/**
 * The Cloudflare browser bypass only runs when the CaptchaSolver background
 * service is started; the app does that during boot, a bare test process must
 * do it explicitly.
 */
async function waitForSolverReady(): Promise<void> {
	const camoufoxManager = getCamoufoxManager();
	await camoufoxManager.waitForAvailabilityCheck();
	if (!camoufoxManager.browserAvailable()) {
		throw new Error(
			`Camoufox browser not available: ${camoufoxManager.getAvailabilityError() ?? 'unknown reason'}`
		);
	}

	const solver = getCaptchaSolver();
	if (captchaSolverSettingsService.isEnabled()) {
		solver.start();
	}
	const deadline = Date.now() + 60_000;
	while (solver.status === 'pending' || solver.status === 'starting') {
		if (Date.now() > deadline) {
			throw new Error('CaptchaSolver did not become ready in time');
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (solver.status !== 'ready') {
		throw new Error(`CaptchaSolver not ready: ${solver.status}`);
	}
}

describe.skipIf(process.env.LIVE_TESTS !== 'true')(
	'Issue #657 live: RuTracker automatic TV searches',
	{ timeout: 300_000 },
	() => {
		beforeAll(async () => {
			await waitForSolverReady();
		});
		async function searchRuTracker(
			criteria: Partial<TvSearchCriteria>
		): Promise<EnhancedReleaseResult[]> {
			const manager = await getIndexerManager();
			const indexers = await manager.getEnabledIndexers();
			const rutracker = indexers.find((indexer) => /rutracker/i.test(indexer.name));
			if (!rutracker) {
				throw new Error('No enabled RuTracker.org indexer configured');
			}

			const result = await manager.searchEnhanced(
				{
					searchType: 'tv',
					query: 'Озарк',
					searchTitles: ['Озарк', 'Ozark'],
					searchSource: 'automatic',
					...criteria
				},
				{
					searchSource: 'automatic',
					allowedIndexerIds: [rutracker.id],
					useCache: false,
					timeout: 120_000
				}
			);

			// eslint-disable-next-line no-console
			console.log(
				'[issue-657 live]',
				JSON.stringify(
					{
						totalResults: result.totalResults,
						afterFiltering: result.afterFiltering,
						afterEnrichment: result.afterEnrichment,
						filterBreakdown: result.filterBreakdown,
						rutrackerTitles: result.releases
							.filter((release) => /rutracker/i.test(release.indexerName))
							.map((release) => release.title)
							.slice(0, 10)
					},
					null,
					2
				)
			);

			return result.releases.filter((release) => /rutracker/i.test(release.indexerName));
		}

		it('automatic season-only search finds season packs via the title-only fallback', async () => {
			const releases = await searchRuTracker({ season: 4 });

			// Before the fix this was always empty: the only query sent was
			// `nm=Озарк%S04`, which RuTracker cannot match.
			expect(releases.length).toBeGreaterThan(0);

			const season4Packs = releases.filter(
				(release) =>
					release.parsed?.episode?.season === 4 || release.parsed?.episode?.seasons?.includes(4)
			);
			expect(season4Packs.length).toBeGreaterThan(0);
		});

		it('automatic season+episode search resolves episode pointers from the cached title-only query', async () => {
			const releases = await searchRuTracker({ season: 4, episode: 1 });

			expect(releases.length).toBeGreaterThan(0);

			// Automatic episode searches surface RuTracker season packs as episode
			// pointers (createEpisodePointerRelease); before the fix the upstream
			// query still carried the S04 token and returned nothing at all.
			const pointers = releases.filter((release) =>
				release.guid.includes('episode-pointer::s04e01')
			);
			expect(pointers.length).toBeGreaterThan(0);
		});
	}
);
