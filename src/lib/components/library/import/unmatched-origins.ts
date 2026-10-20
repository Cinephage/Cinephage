import type { DetectionGroup } from './types.js';

export interface UnmatchedOrigin {
	hash: string;
	progress: number;
}

/**
 * Join detection groups back to the resolved client downloads they came
 * from. Matches on `sourcePath` first, then `selectedFilePath`: detection
 * may normalize, resolve or regroup the input path, and an origin miss
 * must never silently proceed untracked.
 */
export function findUnmatchedOrigin(
	group: Pick<DetectionGroup, 'sourcePath' | 'selectedFilePath'>,
	byPath: ReadonlyMap<string, UnmatchedOrigin>
): UnmatchedOrigin | null {
	return byPath.get(group.sourcePath) ?? byPath.get(group.selectedFilePath) ?? null;
}
