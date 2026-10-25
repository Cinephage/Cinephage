import { describe, expect, it } from 'vitest';

import {
	buildResolvedEpgChannelPlan,
	mapGuideDataToRequestedChannels,
	selectAutoAttachEpgSource
} from './epg-utils';
import type { EpgProgram } from '#lib/types/livetv.js';

function createProgram(channelId: string, title: string): EpgProgram {
	return {
		id: `${channelId}-${title}`,
		channelId,
		externalChannelId: channelId,
		accountId: 'account-1',
		providerType: 'stalker',
		title,
		description: null,
		category: null,
		director: null,
		actor: null,
		startTime: '2026-03-11T00:00:00.000Z',
		endTime: '2026-03-11T01:00:00.000Z',
		duration: 3600,
		hasArchive: false,
		cachedAt: '2026-03-11T00:00:00.000Z',
		updatedAt: '2026-03-11T00:00:00.000Z'
	};
}

describe('epg-utils', () => {
	it('maps guide queries through lineup EPG source overrides', () => {
		const plan = buildResolvedEpgChannelPlan(
			['primary-1', 'primary-2'],
			[
				{ channelId: 'primary-1', epgSourceChannelId: 'source-1' },
				{ channelId: 'primary-2', epgSourceChannelId: null }
			]
		);

		expect(plan.sourceChannelIds).toEqual(['source-1', 'primary-2']);

		const resolved = mapGuideDataToRequestedChannels(
			plan,
			new Map([
				['source-1', [createProgram('source-1', 'Guide A')]],
				['primary-2', [createProgram('primary-2', 'Guide B')]]
			])
		);

		expect(resolved.get('primary-1')?.[0]?.title).toBe('Guide A');
		expect(resolved.get('primary-2')?.[0]?.title).toBe('Guide B');
	});

	it('auto-selects a same-name guide source for noisy variant channels', () => {
		const match = selectAutoAttachEpgSource(
			{
				lineupItemId: 'lineup-1',
				channelId: 'target',
				providerType: 'stalker',
				name: 'SLING| FOX SPORTS 1 RAW',
				categoryId: 'sports'
			},
			[
				{
					channelId: 'candidate-1',
					providerType: 'stalker',
					name: 'US| FOX SPORTS 1 HD',
					categoryId: 'sports',
					programCount: 25
				},
				{
					channelId: 'candidate-2',
					providerType: 'stalker',
					name: 'US| MLB NETWORK',
					categoryId: 'sports',
					programCount: 30
				}
			]
		);

		expect(match?.channelId).toBe('candidate-1');
	});

	it('avoids auto-attaching when the best candidates are tied', () => {
		const match = selectAutoAttachEpgSource(
			{
				lineupItemId: 'lineup-1',
				channelId: 'target',
				providerType: 'stalker',
				name: '(US) ESPN 2 4K+',
				categoryId: 'sports'
			},
			[
				{
					channelId: 'candidate-1',
					providerType: 'stalker',
					name: 'US| ESPN 2 HD',
					categoryId: 'sports',
					programCount: 40
				},
				{
					channelId: 'candidate-2',
					providerType: 'stalker',
					name: 'ESPN 2',
					categoryId: 'sports',
					programCount: 40
				}
			]
		);

		expect(match).toBeNull();
	});
});
