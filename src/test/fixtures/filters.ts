import type {
	GrabDecisionContext,
	GrabDecisionOptions
} from '#lib/server/filters/stages/grab/types.js';
import type { SearchEligibilityContext } from '#lib/server/filters/stages/search/types.js';

export function makeGrabDecisionContext(
	overrides: Partial<GrabDecisionContext> = {}
): GrabDecisionContext {
	return {
		release: {
			title: 'Movie.2024.1080p.WEB-DL.x264',
			size: 5_000_000_000,
			indexerName: 'nzbgeek',
			protocol: 'torrent'
		},
		target: { type: 'movie' as const, movieId: 'movie-1' },
		existingFiles: [],
		profile: {
			id: 'balanced',
			name: 'Balanced',
			description: '',
			tags: [],
			formatScores: {},
			minScore: 0,
			upgradesAllowed: true,
			preventDowngrades: false,
			minScoreIncrement: 10,
			upgradeUntilScore: -1,
			resolutionOrder: [],
			allowedProtocols: ['torrent', 'usenet'],
			isDefault: false
		} as GrabDecisionContext['profile'],
		options: {
			force: false,
			skipBlocklist: false,
			allowSidegrade: false,
			isAutomatic: true
		} as GrabDecisionOptions,
		computed: {},
		...overrides
	};
}

export function makeSearchEligibilityContext(
	overrides: Partial<SearchEligibilityContext> = {}
): SearchEligibilityContext {
	return {
		media: {
			id: 'movie-1',
			monitored: true,
			tmdbId: 12345
		},
		profile: {
			id: 'balanced',
			name: 'Balanced',
			description: '',
			tags: [],
			upgradesAllowed: true,
			preventDowngrades: false,
			minScore: 0,
			upgradeUntilScore: -1,
			minScoreIncrement: 10,
			resolutionOrder: [],
			formatScores: {},
			allowedProtocols: ['torrent', 'usenet'],
			isDefault: false
		} as SearchEligibilityContext['profile'],
		options: { forceSearch: false },
		...overrides
	};
}
