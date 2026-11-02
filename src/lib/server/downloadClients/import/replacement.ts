import type { Resolution } from '#lib/server/indexers/parser/types.js';

/**
 * The ONE import-time replacement policy (acquisition-system redesign).
 *
 * Replacement is computed against CURRENT library state at import time.
 * Grab-time upgrade flags (`download_queue.isUpgrade`, intent decision) are
 * advisory diagnostics only — they never decide which files die. Every
 * protocol (torrent, usenet, debrid, streaming) must go through these
 * functions.
 */

export interface ReplacementFile {
	id: string;
	relativePath: string;
	quality?: { resolution?: string } | null;
	episodeIds?: string[] | null;
	/** .strm placeholders carry their own resolution default; callers resolve. */
	isStrm?: boolean;
}

export interface MovieReplacementInput {
	existingFiles: ReplacementFile[];
	/** Resolution of the incoming file ('unknown' → single-quality semantics). */
	newResolution?: Resolution;
	/** Multi-quality mode for the movie (>= 2 effective desired buckets). */
	multiQuality: boolean;
	/**
	 * Whether the import may retire existing files at all. Single-quality
	 * imports retire all current files; multi-quality imports retire the
	 * same-bucket file. Pass false only for deliberately-additive flows
	 * (none today).
	 */
	retire: boolean;
	/** Never retire this file — the just-imported row (self-deletion guard). */
	keepFileIds?: string[];
}

/**
 * Movie replacement: multi-quality mode replaces only the same resolution
 * bucket; single-quality mode replaces everything (the movie keeps one
 * file). Deterministic, state-based, protocol-independent.
 */
export function computeMovieReplacement(input: MovieReplacementInput): string[] {
	if (!input.retire) return [];
	const keep = new Set(input.keepFileIds ?? []);

	if (input.multiQuality) {
		// Same resolution bucket only. .strm placeholders carry their bucket's
		// resolution like real files, so a real import retires the placeholder
		// in its bucket while leaving other tiers untouched.
		return input.existingFiles
			.filter(
				(file) =>
					!keep.has(file.id) && (file.quality?.resolution ?? undefined) === input.newResolution
			)
			.map((file) => file.id);
	}

	return input.existingFiles.filter((file) => !keep.has(file.id)).map((file) => file.id);
}

export interface EpisodeReplacementInput {
	/** All episode files currently owned by the series (current state). */
	existingFiles: ReplacementFile[];
	/** Episode ids the incoming file covers. */
	incomingEpisodeIds: string[];
	/** Never retire this file — the just-imported row. */
	keepFileIds?: string[];
	/**
	 * .strm placeholders for the covered episodes are always retired when a
	 * real file replaces them, regardless of coverage (the placeholder holds
	 * no exclusive content).
	 */
	retireStrmPlaceholders: boolean;
}

/**
 * Episode replacement with the COVERAGE RULE: a multi-episode file
 * (e.g. an E01-E02 pack) may only be retired when the incoming acquisition
 * preserves every episode it covered — otherwise the other episodes would
 * silently go missing. Single-episode files for covered episodes always
 * retire.
 */
export function computeEpisodeReplacement(input: EpisodeReplacementInput): string[] {
	const incoming = new Set(input.incomingEpisodeIds);
	const keep = new Set(input.keepFileIds ?? []);

	return input.existingFiles
		.filter((file) => !keep.has(file.id))
		.filter((file) => {
			const covered = (file.episodeIds ?? []).filter((episodeId) => incoming.has(episodeId));
			if (covered.length === 0) return false;

			if (file.isStrm ?? file.relativePath.toLowerCase().endsWith('.strm')) {
				return input.retireStrmPlaceholders;
			}

			// Coverage rule: every episode the old file covers must be covered
			// by the incoming acquisition (incoming may cover more).
			const fileEpisodeIds = file.episodeIds ?? [];
			const fullyPreserved = fileEpisodeIds.every((episodeId) => incoming.has(episodeId));
			return fullyPreserved;
		})
		.map((file) => file.id);
}
