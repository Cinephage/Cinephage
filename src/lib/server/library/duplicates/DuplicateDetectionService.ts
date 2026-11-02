/**
 * Duplicate Detection Service (Phase 5)
 *
 * Four detection modes per library:
 *   - off: no detection
 *   - filename: normalize stem, case-insensitive
 *   - filehash: sha256 content hash
 *   - both: filename OR filehash match
 */

import { db } from '#lib/server/db/index.js';
import { movieFiles, episodeFiles, duplicateGroupSuppression } from '#lib/server/db/schema.js';
import { eq, and, isNotNull, sql } from 'drizzle-orm';

export type DupMode = 'off' | 'filename' | 'filehash' | 'both';
export type SignatureType = 'filename' | 'filehash';

export interface DuplicateGroup {
	signature: string;
	signatureType: SignatureType;
	fileIds: string[];
	paths: string[];
	count: number;
	suppressed: boolean;
}

/**
 * Normalize a filename for signature comparison.
 * Lowercase, collapse [\\s.\\-\\_]+ runs to a single space.
 */
export function normalizeFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[\s.\-_]+/g, ' ')
		.trim();
}

/**
 * Find duplicate groups by filename signature.
 */
export async function findFilenameDuplicates(libraryId: string): Promise<DuplicateGroup[]> {
	const all = await db
		.select({
			id: movieFiles.id,
			relativePath: movieFiles.relativePath,
			filenameSignature: movieFiles.filenameSignature
		})
		.from(movieFiles)
		.where(isNotNull(movieFiles.filenameSignature))
		.union(
			db
				.select({
					id: episodeFiles.id,
					relativePath: episodeFiles.relativePath,
					filenameSignature: episodeFiles.filenameSignature
				})
				.from(episodeFiles)
				.where(isNotNull(episodeFiles.filenameSignature))
		)
		.all();

	// Group by signature
	const groups = new Map<string, { ids: string[]; paths: string[] }>();
	for (const f of all) {
		if (!f.filenameSignature) continue;
		const g = groups.get(f.filenameSignature) ?? { ids: [], paths: [] };
		g.ids.push(f.id);
		g.paths.push(f.relativePath ?? f.id);
		groups.set(f.filenameSignature, g);
	}

	return buildDuplicateGroups(groups, libraryId, 'filename');
}

/**
 * Find duplicate groups by content hash.
 */
export async function findHashDuplicates(libraryId: string): Promise<DuplicateGroup[]> {
	const rows = await db.all<{
		id: string;
		relativePath: string | null;
		contentHash: string | null;
		contentHashAlgorithm: string | null;
	}>(
		sql`SELECT id, relative_path as relativePath, content_hash as contentHash, content_hash_algorithm as contentHashAlgorithm FROM movie_files WHERE content_hash IS NOT NULL UNION ALL SELECT id, relative_path as relativePath, content_hash as contentHash, content_hash_algorithm as contentHashAlgorithm FROM episode_files WHERE content_hash IS NOT NULL`
	);

	const groups = new Map<string, { ids: string[]; paths: string[] }>();
	for (const f of rows) {
		if (!f.contentHash) continue;
		const g = groups.get(f.contentHash) ?? { ids: [], paths: [] };
		g.ids.push(f.id);
		g.paths.push(f.relativePath ?? f.id);
		groups.set(f.contentHash, g);
	}

	return buildDuplicateGroups(groups, libraryId, 'filehash');
}

async function buildDuplicateGroups(
	groups: Map<string, { ids: string[]; paths: string[] }>,
	libraryId: string,
	signatureType: SignatureType
): Promise<DuplicateGroup[]> {
	const suppressed = new Set(
		(
			await db
				.select({ signature: duplicateGroupSuppression.signature })
				.from(duplicateGroupSuppression)
				.where(
					and(
						eq(duplicateGroupSuppression.libraryId, libraryId),
						eq(duplicateGroupSuppression.signatureType, signatureType)
					)
				)
				.all()
		).map((r) => r.signature)
	);

	return [...groups.entries()]
		.filter(([, g]) => g.ids.length > 1)
		.map(([sig, g]) => ({
			signature: sig,
			signatureType,
			fileIds: g.ids,
			paths: g.paths,
			count: g.ids.length,
			suppressed: suppressed.has(sig)
		}));
}

/**
 * Suppress a duplicate group so it no longer appears in results.
 */
export async function suppressGroup(
	libraryId: string,
	signature: string,
	signatureType: SignatureType
): Promise<void> {
	await db
		.insert(duplicateGroupSuppression)
		.values({
			libraryId,
			signature,
			signatureType,
			dismissedAt: new Date().toISOString()
		})
		.onConflictDoNothing();
}

/**
 * Undo suppression for a group.
 */
export async function unsuppressGroup(
	libraryId: string,
	signature: string,
	signatureType: SignatureType
): Promise<void> {
	await db
		.delete(duplicateGroupSuppression)
		.where(
			and(
				eq(duplicateGroupSuppression.libraryId, libraryId),
				eq(duplicateGroupSuppression.signature, signature),
				eq(duplicateGroupSuppression.signatureType, signatureType)
			)
		);
}
