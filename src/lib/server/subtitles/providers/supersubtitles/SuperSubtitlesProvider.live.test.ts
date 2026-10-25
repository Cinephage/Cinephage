/**
 * Live SuperSubtitles provider flow.
 *
 * Searches and downloads from the real provider, so it stays out of the
 * normal suite; run it with `npm run test:live`.
 */

import { describe, expect, it } from 'vitest';
import { decodeDownloadContext, SuperSubtitlesProvider } from './SuperSubtitlesProvider';

describe.skipIf(process.env.LIVE_TESTS !== 'true')('SuperSubtitlesProvider live flow', () => {
	const provider = new SuperSubtitlesProvider({
		id: 'live-supersubtitles',
		name: 'Super Subtitles',
		implementation: 'supersubtitles',
		enabled: true,
		priority: 1,
		requestsPerMinute: 30,
		consecutiveFailures: 0
	});

	it('searches and downloads the requested episode from a real season pack', async () => {
		const results = await provider.search({
			title: 'Infected',
			seriesTitle: 'The Last of Us',
			originalTitle: 'The Last of Us',
			year: 2023,
			season: 1,
			episode: 2,
			languages: ['en'],
			filePath: '/media/The.Last.Of.Us.S01E02.1080p.BluRay.x264-PEDRO.mkv'
		});
		const pack = results.find((result) => decodeDownloadContext(result.providerSubtitleId).isPack);
		expect(pack).toBeDefined();
		const content = await provider.download(pack!);
		expect(content.length).toBeGreaterThan(1000);
		expect(content.toString('utf8', 0, 4096)).toContain('-->');
	}, 90000);

	it('searches and downloads a real movie subtitle', async () => {
		const results = await provider.search({
			title: 'Dune: Part Two',
			originalTitle: 'Dune: Part Two',
			year: 2024,
			languages: ['hu']
		});
		expect(results.length).toBeGreaterThan(0);
		const content = await provider.download(results[0]);
		expect(content.length).toBeGreaterThan(1000);
		expect(content.toString('utf8', 0, 4096)).toContain('-->');
	}, 60000);
});
