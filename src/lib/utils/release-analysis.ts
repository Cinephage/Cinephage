interface ReleaseForAnalysis {
	title: string;
	episodeMatch?: {
		season?: number;
		seasons?: number[];
		episodes?: number[];
		isSeasonPack?: boolean;
		isCompleteSeries?: boolean;
	} | null;
	parsed?: {
		episode?: {
			season?: number;
			seasons?: number[];
			episodes?: number[];
			isSeasonPack?: boolean;
			isCompleteSeries?: boolean;
		} | null;
	} | null;
}

export function isMultiSeasonPack(
	release: ReleaseForAnalysis,
	expectedEpisodeCount: number | null | undefined
): boolean {
	const largeEpisodeThreshold = expectedEpisodeCount
		? Math.max(50, Math.floor(expectedEpisodeCount * 0.8))
		: 70;

	const episodeMatch = release.episodeMatch;
	if (episodeMatch) {
		if (episodeMatch.isCompleteSeries) return true;
		if (episodeMatch.seasons && episodeMatch.seasons.length > 1) return true;
		if (
			episodeMatch.isSeasonPack &&
			episodeMatch.season === 1 &&
			(episodeMatch.episodes?.length ?? 0) >= largeEpisodeThreshold
		) {
			return true;
		}
	}

	const episodeInfo = release.parsed?.episode;
	if (episodeInfo) {
		if (episodeInfo.isCompleteSeries) return true;
		if (episodeInfo.seasons && episodeInfo.seasons.length > 1) return true;
		if (
			episodeInfo.isSeasonPack &&
			episodeInfo.season === 1 &&
			(episodeInfo.episodes?.length ?? 0) >= largeEpisodeThreshold
		) {
			return true;
		}
	}

	const t = release.title;
	if (/\bS\d{1,2}[\s._-]*[-–-][\s._-]*S?\d{1,2}\b/i.test(t)) return true;
	if (/\bS\d{1,2}[\s._-]?E\d{1,3}\s*[-–-]\s*S\d{1,2}[\s._-]?E\d{1,3}\b/i.test(t)) return true;
	if (/\b\d{1,2}x\d{1,3}\s*[-–-]\s*\d{1,2}x\d{1,3}\b/i.test(t)) return true;
	if (
		/\bSeasons?[\s:._-]*\d{1,2}\s*(?:[-–-]|to|through|thru)\s*\d{1,2}(?:\s*(?:of|\/)\s*\d{1,2})?\b/i.test(
			t
		)
	)
		return true;
	if (/\bСезоны?[\s:._-]*\d{1,2}\s*(?:[-–-]|до)\s*\d{1,2}(?:\s*(?:из|of|\/)\s*\d{1,2})?\b/i.test(t))
		return true;
	if (
		/\b(?:every[\s._-]?season|all[\s._-]?seasons?|полный[\s._-]*сериал|все[\s._-]*сезоны)\b/i.test(
			t
		)
	)
		return true;

	const hasTvContext =
		/\b(?:series|seasons?|episodes?|s\d{1,2}(?:e\d{1,3})?|(?:\d{1,2})x\d{1,3})\b/i.test(t);
	if (
		hasTvContext &&
		/\b(?:complete[\s._-]?collection|full[\s._-]?collection|mega[\s._-]?pack|bundle)\b/i.test(t)
	)
		return true;

	return false;
}
