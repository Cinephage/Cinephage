/**
 * ReadOnlyFolderSpecification
 *
 * Checks if content is in a read-only root folder.
 * Items in read-only folders (like NZBDav mounts) should be excluded from
 * monitoring searches since imports cannot happen anyway.
 */

import type {
	IMonitoringSpecification,
	MovieContext,
	EpisodeContext,
	SpecificationResult,
	ReleaseCandidate
} from './types.js';
import { reject, accept, RejectionReason } from './types.js';
import { db } from '#lib/server/db/index.js';
import { rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Check if a movie is in a read-only folder
 */
export class MovieReadOnlyFolderSpecification implements IMonitoringSpecification<MovieContext> {
	async isSatisfied(
		context: MovieContext,
		_release?: ReleaseCandidate
	): Promise<SpecificationResult> {
		if (!context.movie.rootFolderId) {
			// No root folder assigned - allow (shouldn't happen in practice)
			return accept();
		}

		const folder = db
			.select({ readOnly: rootFolders.readOnly })
			.from(rootFolders)
			.where(eq(rootFolders.id, context.movie.rootFolderId))
			.get();

		if (folder?.readOnly) {
			return reject(RejectionReason.READ_ONLY_FOLDER);
		}

		return accept();
	}
}

/**
 * Check if an episode's series is in a read-only folder
 */
export class EpisodeReadOnlyFolderSpecification implements IMonitoringSpecification<EpisodeContext> {
	async isSatisfied(
		context: EpisodeContext,
		_release?: ReleaseCandidate
	): Promise<SpecificationResult> {
		if (!context.series.rootFolderId) {
			// No root folder assigned - allow (shouldn't happen in practice)
			return accept();
		}

		const folder = db
			.select({ readOnly: rootFolders.readOnly })
			.from(rootFolders)
			.where(eq(rootFolders.id, context.series.rootFolderId))
			.get();

		if (folder?.readOnly) {
			return reject(RejectionReason.READ_ONLY_FOLDER);
		}

		return accept();
	}
}

/**
 * Convenience function to check if a movie is in a read-only folder
 */
export async function isMovieInReadOnlyFolder(context: MovieContext): Promise<boolean> {
	const spec = new MovieReadOnlyFolderSpecification();
	const result = await spec.isSatisfied(context);
	return !result.accepted;
}

/**
 * Convenience function to check if an episode is in a read-only folder
 */
export async function isEpisodeInReadOnlyFolder(context: EpisodeContext): Promise<boolean> {
	const spec = new EpisodeReadOnlyFolderSpecification();
	const result = await spec.isSatisfied(context);
	return !result.accepted;
}
