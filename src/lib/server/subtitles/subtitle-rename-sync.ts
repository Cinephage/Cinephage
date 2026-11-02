/**
 * Subtitle DB path sync for video renames.
 *
 * When a video file (or its containing folder) is renamed, stem-matched
 * subtitle sidecars are renamed on disk. Their `subtitles.relative_path` rows
 * must follow, otherwise the DB points at a file that no longer exists.
 *
 * Matching uses the current resolved absolute path of each row:
 * - In-place renames: the sidecar keeps its directory, so the resolved old path
 *   equals the mapping's `from`.
 * - Folder moves: the media path in the DB has already been updated by the
 *   time companions are carried, so rows resolve into the NEW folder with their
 *   old basename. A fallback matches those by basename when the resolved row
 *   sits in the same directory as the mapping's destination.
 *
 * Only the owning media's rows are considered, and `relative_path` is rewritten
 * so the row resolves to the new file. Rows are updated in place (the per-file
 * link, where present, is a movieFileId and does not change with a rename).
 */

import { db } from '#lib/server/db/index.js';
import { episodes, subtitles } from '#lib/server/db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { basename, dirname, resolve } from 'node:path';
import { resolveStoredSubtitlePaths } from './subtitle-paths';

export interface SubtitleRenameMapping {
	/** Absolute path of the subtitle file before the rename. */
	from: string;
	/** Absolute path of the subtitle file after the rename. */
	to: string;
}

export interface SubtitleRenameSyncOptions {
	mediaType: 'movie' | 'episode';
	/** Movie id for movies, series id for episodes. */
	mediaId: string;
	mappings: SubtitleRenameMapping[];
}

/**
 * Update `subtitles.relative_path` for rows whose file was renamed on disk.
 * Returns the number of rows updated. Best-effort callers should still wrap in
 * try/catch; DB errors propagate so the caller can decide.
 */
export async function syncSubtitleRowsForRenames(
	options: SubtitleRenameSyncOptions
): Promise<number> {
	if (options.mappings.length === 0) return 0;

	const rows =
		options.mediaType === 'movie'
			? await db.select().from(subtitles).where(eq(subtitles.movieId, options.mediaId))
			: await selectEpisodeSubtitleRows(options.mediaId);

	if (rows.length === 0) return 0;

	const resolved = await resolveStoredSubtitlePaths(rows);
	const byPath = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const abs = resolved.get(row.id);
		if (abs) byPath.set(resolve(abs), row);
	}

	let updated = 0;
	const claimed = new Set<string>();

	for (const mapping of options.mappings) {
		const direct = byPath.get(resolve(mapping.from));
		if (direct) {
			claimed.add(direct.id);
			if (await updateRow(direct, mapping.to)) updated++;
			continue;
		}

		// Folder-move fallback: the row now resolves into the destination
		// directory but still carries the old basename.
		const fromBase = basename(mapping.from);
		for (const row of rows) {
			if (claimed.has(row.id)) continue;
			if (basename(row.relativePath) !== fromBase) continue;
			const abs = resolved.get(row.id);
			if (!abs || dirname(resolve(abs)) !== dirname(resolve(mapping.to))) continue;
			claimed.add(row.id);
			if (await updateRow(row, mapping.to)) updated++;
			break;
		}
	}

	return updated;
}

async function selectEpisodeSubtitleRows(
	seriesId: string
): Promise<Array<typeof subtitles.$inferSelect>> {
	const episodeRows = await db
		.select({ id: episodes.id })
		.from(episodes)
		.where(eq(episodes.seriesId, seriesId));
	if (episodeRows.length === 0) return [];

	return db
		.select()
		.from(subtitles)
		.where(
			inArray(
				subtitles.episodeId,
				episodeRows.map((row) => row.id)
			)
		);
}

/**
 * Rewrite a row's relative path, swapping the file name while preserving any
 * subdirectory prefix the row already carried. Returns true when a value
 * changed (avoids needless writes for folder moves that already resolve
 * correctly).
 */
async function updateRow(row: typeof subtitles.$inferSelect, newAbsPath: string): Promise<boolean> {
	const oldDir = dirname(row.relativePath);
	const newRelative =
		oldDir === '.' || oldDir === ''
			? basename(newAbsPath)
			: `${oldDir.split(/[\\/]+/).join('/')}/${basename(newAbsPath)}`;
	if (newRelative === row.relativePath) return false;

	db.update(subtitles).set({ relativePath: newRelative }).where(eq(subtitles.id, row.id)).run();
	return true;
}
