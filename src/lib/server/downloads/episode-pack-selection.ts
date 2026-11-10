/**
 * Season-pack selection for an episode-pointer grab.
 *
 * Composes the two halves of the pointer domain: which episodes of the season
 * are wanted (episode-pack-scope, database) and which files in this pack version
 * hold them (episode-pointer, pure). The grab handler gets one call and one
 * result instead of assembling the pipeline inline.
 *
 * Automatic grabs fill every wanted episode the pack contains; interactive
 * grabs keep their single-episode semantics.
 */

import {
	buildEpisodePointerFileSelection,
	formatEpisodePointerToken,
	type EpisodePointerFileSelection,
	type EpisodePointerTarget
} from './episode-pointer.js';
import { resolveEpisodePackScope, type EpisodePackScopeEntry } from './episode-pack-scope.js';

export interface EpisodePackSelection extends EpisodePointerFileSelection {
	/** Episode ids that are both wanted and present in the pack, for the queue row. */
	episodeIds: string[];
}

export type EpisodePackSelectionResult =
	{ ok: true; selection: EpisodePackSelection } | { ok: false; error: string };

export async function resolveEpisodePackSelection(params: {
	torrentFile: Buffer;
	target: EpisodePointerTarget;
	seriesId?: string;
	seasonNumber?: number;
	targetEpisodeId?: string;
	isAutomatic: boolean;
}): Promise<EpisodePackSelectionResult> {
	const season = params.target.season ?? params.seasonNumber;
	let packScope: EpisodePackScopeEntry[] = [];
	let targets: EpisodePointerTarget[] = [params.target];

	if (params.isAutomatic && params.seriesId && season !== undefined) {
		packScope = await resolveEpisodePackScope({
			seriesId: params.seriesId,
			seasonNumber: season,
			targetEpisode: params.target.episode,
			targetEpisodeId: params.targetEpisodeId
		});
		if (packScope.length > 1) {
			targets = packScope.map((episode) => ({
				season,
				episode: episode.episodeNumber,
				token: formatEpisodePointerToken(season, episode.episodeNumber)
			}));
		}
	}

	const selection = await buildEpisodePointerFileSelection(params.torrentFile, targets);

	// The triggering episode must be in the pack: grabbing the other six while
	// the one that was asked for is missing would leave the search target
	// undownloaded and the queue row lying about its scope.
	if (
		selection.fileIndices.length === 0 ||
		!selection.matchedEpisodes.includes(params.target.episode)
	) {
		return {
			ok: false,
			error: `Could not map ${params.target.token} to files inside this season pack`
		};
	}

	const selectedEpisodes = new Set(selection.matchedEpisodes);
	const episodeIds = packScope.flatMap((episode) =>
		episode.episodeId && selectedEpisodes.has(episode.episodeNumber) ? [episode.episodeId] : []
	);

	return { ok: true, selection: { ...selection, episodeIds } };
}
