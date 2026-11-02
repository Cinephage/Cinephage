/**
 * Multi-quality bucket helpers.
 *
 * Supports maintaining multiple resolution "tiers" of the same movie (e.g. a
 * 2160p file AND a 1080p file). All functions here are pure — they operate on
 * arrays/values passed in, so DB-coupled callers fetch files then delegate here.
 *
 * Activation rule: a movie is in "multi-quality mode" when it has
 * {@link MULTI_QUALITY_MIN_BUCKETS} or more *effective* buckets (desired
 * resolutions clamped to the scoring profile's min/max range). With fewer,
 * existing single-quality behavior is preserved exactly.
 */
import { RESOLUTION_ORDER, type Resolution } from '#lib/server/indexers/parser/types.js';

/** Minimum effective buckets to activate multi-quality behavior. */
export const MULTI_QUALITY_MIN_BUCKETS = 2;

/** Minimal file shape the bucket helpers need. */
export interface BucketFile {
	id: string;
	relativePath: string;
	quality?: { resolution?: string } | null;
	size?: number | null;
}

/**
 * Desired resolutions clamped to the scoring profile's resolution range.
 * Drops 'unknown' and duplicates, preserving declared order.
 */
export function effectiveBuckets(
	desiredQualities: Resolution[] | null | undefined,
	minResolution: string | null | undefined,
	maxResolution: string | null | undefined
): Resolution[] {
	if (!desiredQualities || desiredQualities.length === 0) return [];
	const min = minResolution
		? (RESOLUTION_ORDER[minResolution as Resolution] ?? -Infinity)
		: -Infinity;
	const max = maxResolution
		? (RESOLUTION_ORDER[maxResolution as Resolution] ?? Infinity)
		: Infinity;

	const seen = new Set<Resolution>();
	const out: Resolution[] = [];
	for (const r of desiredQualities) {
		if (r === 'unknown' || seen.has(r)) continue;
		seen.add(r);
		const ord = RESOLUTION_ORDER[r] ?? -1;
		if (ord < min || ord > max) continue;
		out.push(r);
	}
	return out;
}

/** True when multi-quality behavior should activate for the given effective buckets. */
export function isMultiQualityMode(effective: Resolution[]): boolean {
	return effective.length >= MULTI_QUALITY_MIN_BUCKETS;
}

/** Unique, known resolutions present among the given files (insertion order). */
export function getFilledResolutions(files: BucketFile[]): Resolution[] {
	const out: Resolution[] = [];
	const seen = new Set<Resolution>();
	for (const f of files) {
		const r = f.quality?.resolution as Resolution | undefined;
		if (!r || r === 'unknown' || seen.has(r)) continue;
		seen.add(r);
		out.push(r);
	}
	return out;
}

/** Effective buckets that have no matching file yet. */
export function unfilledBuckets(effective: Resolution[], filled: Resolution[]): Resolution[] {
	const filledSet = new Set(filled);
	return effective.filter((r) => !filledSet.has(r));
}

/**
 * Best existing file *within a single resolution bucket*. Ranking mirrors
 * MonitoringSearchService.selectBestExistingFile: prefers downloaded (non-.strm)
 * files, then larger size. Resolution rank is constant within a bucket so it is
 * intentionally not part of the score here.
 */
export function selectBestExistingFileInBucket<T extends BucketFile>(
	files: T[],
	resolution: Resolution
): T | undefined {
	const inBucket = files.filter(
		(f) => (f.quality?.resolution as Resolution | undefined) === resolution
	);
	if (inBucket.length === 0) return undefined;

	let best = inBucket[0];
	let bestScore = scoreFile(best);
	for (let i = 1; i < inBucket.length; i++) {
		const s = scoreFile(inBucket[i]);
		if (s > bestScore) {
			best = inBucket[i];
			bestScore = s;
		}
	}
	return best;
}

function scoreFile(f: BucketFile): number {
	const isStrm = f.relativePath?.toLowerCase().endsWith('.strm') ?? false;
	const typeBonus = isStrm ? 0 : 10_000;
	const sizeMb = (f.size ?? 0) / (1024 * 1024);
	return typeBonus + Math.min(sizeMb, 100);
}

/**
 * Best file overall (across buckets), used as the representative "primary" file
 * for a movie (e.g. quality badges, score display). Ranks by downloaded vs strm,
 * then resolution, then size. Mirrors MonitoringSearchService.selectBestExistingFile.
 */
export function selectBestFile<T extends BucketFile>(files: T[]): T | undefined {
	if (files.length === 0) return undefined;
	let best = files[0];
	let bestScore = overallScore(best);
	for (let i = 1; i < files.length; i++) {
		const s = overallScore(files[i]);
		if (s > bestScore) {
			best = files[i];
			bestScore = s;
		}
	}
	return best;
}

function overallScore(f: BucketFile): number {
	const isStrm = f.relativePath?.toLowerCase().endsWith('.strm') ?? false;
	const typeBonus = isStrm ? 0 : 10_000;
	const resRank = RESOLUTION_ORDER[(f.quality?.resolution as Resolution) ?? 'unknown'] ?? 0;
	const sizeMb = (f.size ?? 0) / (1024 * 1024);
	return typeBonus + resRank * 1000 + Math.min(sizeMb, 100);
}

/**
 * IDs of existing files that should be deleted when importing a new file of
 * `newResolution`. In multi-quality mode only same-bucket files are replaced
 * (filling an empty bucket replaces nothing); in single-quality mode every
 * existing file is replaced (current behavior).
 */
export function fileIdsToReplace(
	existingFiles: BucketFile[],
	newResolution: Resolution | undefined,
	multiQuality: boolean
): string[] {
	if (!multiQuality) {
		return existingFiles.map((f) => f.id);
	}
	if (!newResolution) return [];
	return existingFiles
		.filter((f) => (f.quality?.resolution as Resolution | undefined) === newResolution)
		.map((f) => f.id);
}

/**
 * IDs of existing files that are "redundant" — they don't fit the movie's
 * desired-quality tiers. Used to surface cleanup opportunities (insight) and
 * to power opt-in removal on desiredQualities changes. Never auto-deleted.
 *
 *  - Multi-quality (effective length >= 2): files whose KNOWN resolution is
 *    NOT in `effective` (a tier the user no longer desires).
 *  - Single-quality (effective length < 2, incl. null/[]): every file EXCEPT
 *    the `selectBestFile` winner (e.g. a 720p file next to a 1080p "best").
 *
 * Unknown-resolution files are NEVER flagged (we don't auto-classify what we
 * can't identify).
 */
export function redundantFileIds<T extends BucketFile>(
	files: T[],
	effective: Resolution[]
): string[] {
	if (files.length === 0) return [];
	if (isMultiQualityMode(effective)) {
		return files
			.filter((f) => {
				const r = f.quality?.resolution as Resolution | undefined;
				if (!r || r === 'unknown') return false;
				return !effective.includes(r);
			})
			.map((f) => f.id);
	}
	const best = selectBestFile(files);
	return files
		.filter((f) => f.id !== best?.id)
		.filter((f) => {
			const r = f.quality?.resolution as Resolution | undefined;
			return !!r && r !== 'unknown';
		})
		.map((f) => f.id);
}

/**
 * Decide which existing file IDs to delete when importing a new file. Unifies
 * the import/upgrade replace policy so ImportService and StreamingHandler share
 * one tested decision:
 *  - multi-quality: only the file(s) in the SAME resolution bucket (filling an
 *    empty bucket replaces nothing); isUpgrade is irrelevant.
 *  - single-quality: all files when this is an upgrade, none otherwise.
 */
export function replaceIdsForImport(
	existingFiles: BucketFile[],
	options: { newResolution?: Resolution; multiQuality: boolean; isUpgrade: boolean }
): string[] {
	const { newResolution, multiQuality, isUpgrade } = options;
	if (multiQuality) {
		return fileIdsToReplace(existingFiles, newResolution, true);
	}
	return isUpgrade ? existingFiles.map((f) => f.id) : [];
}
