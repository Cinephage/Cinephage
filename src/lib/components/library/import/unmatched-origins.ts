import type { DetectionGroup } from './types.js';

export interface UnmatchedOrigin {
	hash: string;
	progress: number;
}

function normalizePath(path: string): string {
	return path.replace(/\/+$/, '');
}

/**
 * True when `candidatePath` is `parentPath` itself or a path inside it.
 * String-based (not node:path) because this module also runs in the
 * browser; paths here are always server-reported POSIX paths. Compares
 * against a `/`-terminated parent so a sibling with a shared prefix
 * (`/data/incoming/a` vs `/data/incoming/ab`) never matches.
 */
function isSameOrDescendant(candidatePath: string, parentPath: string): boolean {
	const candidate = normalizePath(candidatePath);
	const parent = normalizePath(parentPath);
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

/**
 * Join detection groups back to the resolved client downloads they came
 * from. Matches on `sourcePath` first, then `selectedFilePath`: detection
 * may normalize, resolve or regroup the input path, and an origin miss
 * must never silently proceed untracked.
 *
 * Folder-based items (multi-file releases, season packs) key `byPath` on
 * the client's content *folder*, but detection always returns the video
 * *file* inside it - so after an exact miss, fall back to a containment
 * check: is the detected file inside one of the known content paths?
 */
export function findUnmatchedOrigin(
	group: Pick<DetectionGroup, 'sourcePath' | 'selectedFilePath'>,
	byPath: ReadonlyMap<string, UnmatchedOrigin>
): UnmatchedOrigin | null {
	const exact = byPath.get(group.sourcePath) ?? byPath.get(group.selectedFilePath);
	if (exact) return exact;

	for (const [path, origin] of byPath) {
		if (
			isSameOrDescendant(group.sourcePath, path) ||
			isSameOrDescendant(group.selectedFilePath, path)
		) {
			return origin;
		}
	}
	return null;
}
