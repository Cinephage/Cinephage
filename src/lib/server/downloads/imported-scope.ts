/**
 * What a release hash has already delivered.
 *
 * A torrent hash identifies a release, and a season pack is a living topic: the
 * author re-creates it as new episodes air, so the same hash is grabbed again
 * later for episodes it did not deliver the first time (#663). Duplicate
 * detection therefore has to ask a scoped question - "has this hash already
 * been imported *for the episodes this grab wants*" - rather than "has this
 * hash ever been imported". The unscoped answer makes every later episode
 * inside an imported pack unreachable without manual history surgery.
 *
 * Imported history is the record of what actually reached the library, so it is
 * the only thing consulted here. Queue rows answer a different question (is a
 * download still running) and stay with the duplicate stages.
 */
import { and, eq, or } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { downloadHistory } from '#lib/server/db/schema.js';

export interface ImportedScope {
	/** An imported history row exists for this hash. */
	imported: boolean;
	/** Requested episodes this hash already delivered. */
	coveredEpisodeIds: string[];
	/** Requested episodes this hash has not delivered. */
	missingEpisodeIds: string[];
	/** The hash is a duplicate for this request: imported, and covering its scope. */
	satisfied: boolean;
}

export interface ImportedScopeQuery {
	infoHash: string;
	movieId?: string | null;
	seriesId?: string | null;
	/** Requested episode scope; empty or absent means "the whole release". */
	episodeIds?: readonly string[] | null;
}

/**
 * Which of the requested episodes this hash already delivered.
 *
 * A movie, or any target without an episode scope, is satisfied by the hash
 * having been imported at all - the pre-#663 behaviour, deliberately unchanged.
 */
export async function resolveImportedScope(input: ImportedScopeQuery): Promise<ImportedScope> {
	const requested = [...new Set((input.episodeIds ?? []).filter((id) => Boolean(id)))];

	const rows = await db
		.select({
			movieId: downloadHistory.movieId,
			seriesId: downloadHistory.seriesId,
			episodeIds: downloadHistory.episodeIds
		})
		.from(downloadHistory)
		.where(
			and(
				or(
					eq(downloadHistory.infoHash, input.infoHash),
					eq(downloadHistory.downloadId, input.infoHash)
				),
				eq(downloadHistory.status, 'imported')
			)
		);

	if (rows.length === 0) {
		return {
			imported: false,
			coveredEpisodeIds: [],
			missingEpisodeIds: requested,
			satisfied: false
		};
	}

	// Rows with no target at all (legacy records, or a media link cleared by a
	// delete) count for every target: refusing them would re-grab a release the
	// library already holds.
	const scoped = rows.filter((row) => {
		if (input.movieId) return !row.movieId || row.movieId === input.movieId;
		if (input.seriesId) return !row.seriesId || row.seriesId === input.seriesId;
		return true;
	});

	// The hash was imported, but only for a different movie or series. That is a
	// misidentification rather than a re-grab - a release belongs to one target -
	// so it stays a duplicate, which is what this check did before it was scoped.
	if (scoped.length === 0) {
		return {
			imported: true,
			coveredEpisodeIds: [],
			missingEpisodeIds: [],
			satisfied: true
		};
	}

	if (requested.length === 0) {
		return { imported: true, coveredEpisodeIds: [], missingEpisodeIds: [], satisfied: true };
	}

	// A row with no episode scope records a whole-release import (a movie, or a
	// pack imported before episode scopes were recorded): it covers whatever
	// this grab asks for.
	const coversEverything = scoped.some((row) => (row.episodeIds ?? []).length === 0);
	const delivered = new Set(scoped.flatMap((row) => row.episodeIds ?? []));

	const coveredEpisodeIds = coversEverything
		? requested
		: requested.filter((episodeId) => delivered.has(episodeId));
	const missingEpisodeIds = coversEverything
		? []
		: requested.filter((episodeId) => !delivered.has(episodeId));

	return {
		imported: true,
		coveredEpisodeIds,
		missingEpisodeIds,
		satisfied: missingEpisodeIds.length === 0
	};
}
