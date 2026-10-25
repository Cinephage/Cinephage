/**
 * Client-safe (no server imports) ranking mirror of the server
 * {@link import('#lib/server/quality/buckets.js').selectBestFile}. Used by
 * client-side code (types, utils, Svelte components) that cannot import the
 * server helper directly.
 *
 * Keep RESOLUTION_RANK in sync with RESOLUTION_ORDER in
 * `src/lib/server/indexers/parser/types.ts` and scoreFile() in sync with
 * overallScore() in `src/lib/server/quality/buckets.ts`.
 */
const RESOLUTION_RANK: Record<string, number> = {
	'2160p': 4,
	'1080p': 3,
	'720p': 2,
	'480p': 1
};

export interface RankableMovieFile {
	relativePath: string;
	quality?: { resolution?: string } | null;
	size?: number | null;
}

/**
 * Pick the representative "best" movie file: prefer downloaded (non-.strm),
 * then higher resolution, then larger size. Returns undefined for empty input.
 */
export function pickBestMovieFile<T extends RankableMovieFile>(
	files: T[] | null | undefined
): T | undefined {
	if (!files || files.length === 0) return undefined;
	let best = files[0];
	let bestScore = scoreFile(best);
	for (let i = 1; i < files.length; i++) {
		const s = scoreFile(files[i]);
		if (s > bestScore) {
			best = files[i];
			bestScore = s;
		}
	}
	return best;
}

function scoreFile(f: RankableMovieFile): number {
	const isStrm = f.relativePath?.toLowerCase().endsWith('.strm') ?? false;
	const typeBonus = isStrm ? 0 : 10_000;
	const resRank = RESOLUTION_RANK[f.quality?.resolution ?? 'unknown'] ?? 0;
	const sizeMb = (f.size ?? 0) / (1024 * 1024);
	return typeBonus + resRank * 1000 + Math.min(sizeMb, 100);
}

/**
 * Minimum effective resolutions to activate multi-quality behavior. Mirrors
 * MULTI_QUALITY_MIN_BUCKETS in `src/lib/server/quality/buckets.ts`.
 */
const MULTI_QUALITY_MIN_BUCKETS = 2;

/**
 * Approximate client-side mirror of the server
 * {@link import('#lib/server/quality/buckets.js').effectiveBuckets}: clamps the
 * desired resolutions to the scoring profile's resolution range using
 * RESOLUTION_RANK, dropping unknown/unrecognized values and deduping while
 * preserving declared order.
 *
 * Keep in sync with `src/lib/server/quality/buckets.ts` `effectiveBuckets`;
 * differs only for unrecognized resolution strings (dropped here), which don't
 * occur for typed input.
 */
export function effectiveResolutions(
	desired: string[] | null | undefined,
	minResolution?: string | null,
	maxResolution?: string | null
): string[] {
	if (!desired || desired.length === 0) return [];
	const min = minResolution ? (RESOLUTION_RANK[minResolution] ?? -Infinity) : -Infinity;
	const max = maxResolution ? (RESOLUTION_RANK[maxResolution] ?? Infinity) : Infinity;

	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of desired) {
		if (r === 'unknown' || seen.has(r)) continue;
		seen.add(r);
		const rank = RESOLUTION_RANK[r];
		if (rank === undefined) continue;
		if (rank < min || rank > max) continue;
		out.push(r);
	}
	return out;
}

/**
 * Client-safe mirror of the server
 * {@link import('#lib/server/quality/buckets.js').redundantFileIds}. Returns the
 * IDs of existing files that don't fit the movie's effective desired-quality
 * tiers:
 *  - Multi-quality (effective length >= 2): files whose KNOWN resolution is NOT
 *    in `effective`.
 *  - Single-quality (effective length < 2, incl. empty): every file EXCEPT the
 *    {@link pickBestMovieFile} winner.
 *
 * Unknown-resolution files are NEVER flagged.
 */
export function redundantMovieFileIds<T extends RankableMovieFile & { id: string }>(
	files: T[] | null | undefined,
	effective: string[]
): string[] {
	if (!files || files.length === 0) return [];
	if (effective.length >= MULTI_QUALITY_MIN_BUCKETS) {
		const wanted = new Set(effective);
		return files
			.filter((f) => {
				const r = f.quality?.resolution;
				if (!r || r === 'unknown') return false;
				return !wanted.has(r);
			})
			.map((f) => f.id);
	}
	const best = pickBestMovieFile(files);
	return files
		.filter((f) => f.id !== best?.id)
		.filter((f) => {
			const r = f.quality?.resolution;
			return !!r && r !== 'unknown';
		})
		.map((f) => f.id);
}
