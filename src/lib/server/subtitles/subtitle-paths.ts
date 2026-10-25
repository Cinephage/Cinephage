/**
 * Stored subtitle path resolution.
 *
 * Single source of truth for turning a `subtitles` row into the absolute path
 * of its file on disk. Used by download/delete (SubtitleDownloadService) and by
 * status disk verification (LanguageProfileService), so the base directory rules
 * cannot drift between them:
 *
 * - movie rows are relative to the movie folder:
 *     join(rootFolder.path, movie.path, row.relativePath)
 * - episode rows are relative to the directory of the owning episode file
 *   (which includes the season folder when the library uses one):
 *     join(rootFolder.path, series.path, dirname(episodeFile.relativePath), row.relativePath)
 *
 * Any missing owner (movie/episode/series/root folder/episode file) resolves to
 * null; callers must treat null as "cannot verify on disk".
 *
 * SubtitleSyncService uses these helpers for both subtitle and paired video
 * paths while retaining its multi-quality file lookup behavior.
 */

import { db } from '#lib/server/db/index.js';
import {
	episodeFiles,
	episodes,
	movies,
	rootFolders,
	series,
	subtitles
} from '#lib/server/db/schema.js';
import { inArray } from 'drizzle-orm';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A row from the `subtitles` table. */
export type StoredSubtitleRow = typeof subtitles.$inferSelect;

/**
 * Inverse of the resolution rules: derive the value to store in
 * `subtitles.relative_path` for a sidecar at `absPath` given the base directory
 * the row will later be resolved against.
 *
 * - movie rows: `mediaDirAbs` is the absolute movie folder.
 * - episode rows: `mediaDirAbs` is the absolute directory of the owning episode
 *   file (which includes the season folder when the library uses one):
 *     toStoredRelativePath(sub.path, join(rootFolder.path, series.path, dirname(episodeFile.relativePath)))
 *
 * Separators are always normalized to `/` so stored values match migration 141's
 * rewrite and stay filesystem independent. The scanner (writer) and
 * `resolveStoredSubtitlePath` (reader) therefore share one definition of the
 * base, preventing the drift that previously left scanner episode rows dangling.
 *
 * Callers must pass the correct base; a path outside it yields a `../`-prefixed
 * value rather than an error.
 */
export function toStoredRelativePath(absPath: string, mediaDirAbs: string): string {
	return relative(mediaDirAbs, absPath)
		.split(/[\\/]+/)
		.join('/');
}

/**
 * Resolve the absolute path for a single stored subtitle row.
 * Returns null when the owner cannot be resolved.
 */
export async function resolveStoredSubtitlePath(row: StoredSubtitleRow): Promise<string | null> {
	const resolved = await resolveStoredSubtitlePaths([row]);
	return resolved.get(row.id) ?? null;
}

/** Resolve a stored media-relative path without following it outside its base. */
export async function resolvePathWithinBase(
	basePath: string,
	storedPath: string
): Promise<string | null> {
	const normalizedBase = resolve(basePath);
	const candidate = resolve(normalizedBase, storedPath.replace(/[\\/]+/g, sep));
	if (!isWithinPath(candidate, normalizedBase)) return null;

	const canonicalBase = await realpath(normalizedBase).catch(() => normalizedBase);
	const canonicalCandidate = await realpath(candidate).catch(async () => {
		const canonicalParent = await realpath(dirname(candidate)).catch(() => null);
		return canonicalParent ? join(canonicalParent, basename(candidate)) : null;
	});
	if (canonicalCandidate && !isWithinPath(canonicalCandidate, canonicalBase)) return null;

	return candidate;
}

/**
 * Resolve a path for a destructive operation. Final symlinks are rejected;
 * regular files are returned under their canonical parent directory. This
 * keeps rename/unlink operations portable without following a retargetable
 * subtitle link or relying on procfs.
 */
export async function resolveDestructivePathWithinBase(
	basePath: string,
	candidatePath: string
): Promise<string | null> {
	const candidate = await resolvePathWithinBase(basePath, candidatePath);
	if (!candidate) return null;

	const canonicalBase = await realpath(resolve(basePath)).catch(() => null);
	const canonicalParent = await realpath(dirname(candidate)).catch(() => null);
	if (!canonicalBase || !canonicalParent || !isWithinPath(canonicalParent, canonicalBase)) {
		return null;
	}

	const stats = await lstat(candidate).catch(() => null);
	if (stats?.isSymbolicLink()) return null;

	return join(canonicalParent, basename(candidate));
}

/** Resolve an existing regular file for safe read-only use. */
export async function resolveCanonicalRegularPathWithinBase(
	basePath: string,
	candidatePath: string
): Promise<string | null> {
	const candidate = await resolvePathWithinBase(basePath, candidatePath);
	if (!candidate) return null;

	const canonicalBase = await realpath(resolve(basePath)).catch(() => null);
	const canonicalCandidate = await realpath(candidate).catch(() => null);
	if (!canonicalBase || !canonicalCandidate || !isWithinPath(canonicalCandidate, canonicalBase)) {
		return null;
	}

	const stats = await lstat(canonicalCandidate).catch(() => null);
	return stats?.isFile() ? canonicalCandidate : null;
}

/**
 * Open a path and verify the file selected by that open is still inside the
 * base. The returned handle is the authority for subsequent I/O, so a later
 * symlink retarget cannot redirect the operation to another file.
 */
export async function openPathWithinBase(
	basePath: string,
	candidatePath: string,
	flags: Parameters<typeof open>[1] = 'r'
) {
	const candidate = await resolvePathWithinBase(basePath, candidatePath);
	if (!candidate) throw new Error('Path is outside the allowed base');
	if (isWriteMode(flags) && (await lstat(candidate).catch(() => null))?.isSymbolicLink()) {
		throw new Error('Refusing to open a symlink for writing');
	}

	const canonicalBase = await realpath(resolve(basePath));
	const canonicalCandidate = await realpath(candidate).catch(async () => {
		if (!isWriteMode(flags)) throw new Error('Path does not exist');
		const canonicalParent = await realpath(dirname(candidate));
		return join(canonicalParent, basename(candidate));
	});
	if (!isWithinPath(canonicalCandidate, canonicalBase)) {
		throw new Error('Path is outside the allowed base');
	}

	const handle = await open(canonicalCandidate, addNoFollow(flags));
	Object.assign(handle, { canonicalPath: canonicalCandidate });
	try {
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}

	function addNoFollow(value: Parameters<typeof open>[1]): Parameters<typeof open>[1] {
		if (!constants.O_NOFOLLOW) return value;
		if (typeof value === 'number') return value | constants.O_NOFOLLOW;
		if (typeof value !== 'string') return value;

		const access = value[0];
		const plus = value.includes('+');
		const exclusive = value.includes('x');
		const sync = value.includes('s');
		let numericFlags =
			access === 'r'
				? plus
					? constants.O_RDWR
					: constants.O_RDONLY
				: access === 'w'
					? (plus ? constants.O_RDWR : constants.O_WRONLY) | constants.O_CREAT | constants.O_TRUNC
					: (plus ? constants.O_RDWR : constants.O_WRONLY) | constants.O_CREAT | constants.O_APPEND;
		if (exclusive) numericFlags |= constants.O_EXCL;
		if (sync) numericFlags |= constants.O_SYNC;
		return numericFlags | constants.O_NOFOLLOW;
	}

	function isWriteMode(value: Parameters<typeof open>[1]): boolean {
		if (typeof value === 'string') return value[0] !== 'r' || value.includes('+');
		if (typeof value !== 'number') return false;
		return Boolean(
			value &
			(constants.O_WRONLY |
				constants.O_RDWR |
				constants.O_APPEND |
				constants.O_CREAT |
				constants.O_TRUNC |
				constants.O_EXCL)
		);
	}
}

/**
 * Batch-resolve absolute paths for stored subtitle rows with a single set of DB
 * queries (no N+1). Rows that cannot be resolved map to null.
 */
export async function resolveStoredSubtitlePaths(
	rows: StoredSubtitleRow[]
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>();
	if (rows.length === 0) return result;

	const movieIds = uniqueStrings(rows.map((row) => row.movieId));
	const episodeIds = uniqueStrings(rows.map((row) => row.episodeId));

	const movieRows = movieIds.length
		? await db.select().from(movies).where(inArray(movies.id, movieIds))
		: [];
	const episodeRows = episodeIds.length
		? await db.select().from(episodes).where(inArray(episodes.id, episodeIds))
		: [];

	const movieById = new Map(movieRows.map((row) => [row.id, row]));
	const episodeById = new Map(episodeRows.map((row) => [row.id, row]));

	const seriesIds = uniqueStrings(episodeRows.map((row) => row.seriesId));
	const seriesRows = seriesIds.length
		? await db.select().from(series).where(inArray(series.id, seriesIds))
		: [];
	const seriesById = new Map(seriesRows.map((row) => [row.id, row]));

	const fileRows = seriesIds.length
		? await db.select().from(episodeFiles).where(inArray(episodeFiles.seriesId, seriesIds))
		: [];
	const filesBySeries = new Map<string, typeof fileRows>();
	for (const file of fileRows) {
		const list = filesBySeries.get(file.seriesId);
		if (list) list.push(file);
		else filesBySeries.set(file.seriesId, [file]);
	}

	const rootFolderIds = uniqueStrings([
		...movieRows.map((row) => row.rootFolderId),
		...seriesRows.map((row) => row.rootFolderId)
	]);
	const rootFolderRows = rootFolderIds.length
		? await db.select().from(rootFolders).where(inArray(rootFolders.id, rootFolderIds))
		: [];
	const rootFolderById = new Map(rootFolderRows.map((row) => [row.id, row]));

	for (const row of rows) {
		result.set(row.id, await resolveRow(row));
	}

	return result;

	async function resolveRow(row: StoredSubtitleRow): Promise<string | null> {
		if (row.movieId) {
			const movie = movieById.get(row.movieId);
			if (!movie || !movie.rootFolderId) return null;

			const rootFolder = rootFolderById.get(movie.rootFolderId);
			if (!rootFolder) return null;

			return resolvePathWithinBase(join(rootFolder.path, movie.path), row.relativePath);
		}

		if (row.episodeId) {
			const episode = episodeById.get(row.episodeId);
			if (!episode) return null;

			const seriesRow = seriesById.get(episode.seriesId);
			if (!seriesRow || !seriesRow.rootFolderId) return null;

			const rootFolder = rootFolderById.get(seriesRow.rootFolderId);
			if (!rootFolder) return null;

			const candidates = (filesBySeries.get(seriesRow.id) ?? []).filter((file) =>
				(file.episodeIds as string[] | null)?.includes(row.episodeId!)
			);
			if (candidates.length === 0) return null;

			// Subtitle rows carry no episode-file link, so pick the owning file
			// deterministically (path, then id) so repeated calls agree.
			return resolvePathWithinBase(
				join(rootFolder.path, seriesRow.path, dirname(sortByPath(candidates)[0].relativePath)),
				row.relativePath
			);
		}

		return null;
	}
}

function isWithinPath(pathToCheck: string, basePath: string): boolean {
	const pathFromBase = relative(basePath, pathToCheck);
	return pathFromBase === '' || (!pathFromBase.startsWith('..') && !isAbsolute(pathFromBase));
}

/** Sort episode-file candidates deterministically by relative path then id. */
function sortByPath<T extends { relativePath: string; id: string }>(files: T[]): T[] {
	return [...files].sort((a, b) =>
		a.relativePath === b.relativePath
			? a.id.localeCompare(b.id)
			: a.relativePath.localeCompare(b.relativePath)
	);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}
