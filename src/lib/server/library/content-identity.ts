/**
 * Content-identity guard (issue #598): decide whether a file about to be
 * imported is byte-identical to one the library already has, so the
 * transfer can be skipped instead of writing a duplicate.
 */

import type { movieFiles } from '#lib/server/db/schema.js';

type MediaInfo = NonNullable<typeof movieFiles.$inferSelect.mediaInfo>;

export interface ExistingFileIdentity {
	infoHash?: string | null;
	size?: number | null;
	mediaInfo?: MediaInfo | null;
}

/**
 * True when `candidate` is the same content as `existingFile`.
 *
 * `infoHash` match is authoritative (both sides are hashes of the same
 * torrent/nzb content) and decides it on its own. Otherwise falls back to
 * size plus full `mediaInfo` field equality - good enough to tell a
 * genuine re-grab of the same release apart from a real upgrade, without
 * needing a file-content hash.
 */
export function contentAlreadyPresent(
	existingFile: ExistingFileIdentity,
	candidateInfoHash: string | null | undefined,
	candidateSize: number | null | undefined,
	candidateMediaInfo: MediaInfo | null | undefined
): boolean {
	if (candidateInfoHash && existingFile.infoHash && candidateInfoHash === existingFile.infoHash) {
		return true;
	}

	if (
		candidateSize == null ||
		existingFile.size == null ||
		candidateSize !== existingFile.size ||
		!candidateMediaInfo ||
		!existingFile.mediaInfo
	) {
		return false;
	}

	return mediaInfoEqual(candidateMediaInfo, existingFile.mediaInfo);
}

function mediaInfoEqual(a: MediaInfo, b: MediaInfo): boolean {
	const keys = new Set<keyof MediaInfo>([
		...(Object.keys(a) as (keyof MediaInfo)[]),
		...(Object.keys(b) as (keyof MediaInfo)[])
	]);
	for (const key of keys) {
		const aValue = a[key];
		const bValue = b[key];
		if (Array.isArray(aValue) || Array.isArray(bValue)) {
			if (!arraysEqual(aValue as unknown[] | undefined, bValue as unknown[] | undefined)) {
				return false;
			}
			continue;
		}
		if (aValue !== bValue) return false;
	}
	return true;
}

function arraysEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
	if (!a || !b) return a === b;
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}
