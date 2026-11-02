import type { ScoringProfile } from '#lib/server/scoring/types.js';

export interface SearchEligibilityContext {
	media: {
		id: string;
		monitored: boolean;
		tmdbId: number;
		minimumAvailability?: string | null;
		rootFolderId?: string | null;
		lastSearchTime?: string | null;
		releaseDate?: string | null;
		digitalReleaseDate?: string | null;
		physicalReleaseDate?: string | null;
		downloadReleaseDate?: string | null;
		availabilityDelay?: number | null;
		year?: number | null;
		added?: string | null;
	};
	episode?: {
		id: string;
		monitored: boolean;
		seasonId?: string | null;
		lastSearchTime?: string | null;
	};
	series?: {
		id: string;
		monitored: boolean;
		rootFolderId?: string | null;
	};
	existingFile?: {
		id: string;
		relativePath: string;
	} | null;
	profile: ScoringProfile;
	options: {
		forceSearch: boolean;
	};
}
