/**
 * Debrid file-listing evidence probe (audio-language acquisition, tier 3).
 *
 * For a release candidate that is about to be grabbed, ask the configured
 * debrid provider(s) for the torrent's cached file list WITHOUT downloading:
 * file names carry language tokens far more reliably than release titles
 * (the Torrentio mechanism — see the 2026-09-15 design spec §2.2). Results
 * are cached by infohash; uncached/unsupported answers are cached as null
 * (negative cache) so repeated grabs don't re-probe.
 *
 * Best-effort by design: any failure returns null and logs at debug — this
 * must never block or slow a grab decision beyond the single probe call.
 */

import type { ProviderFile } from '#lib/server/downloadClients/debrid/debrid-adapter.js';
import { extractLanguagesFromFileName } from '#lib/server/indexers/parser/patterns/language.js';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'downloads' as const });

const EVIDENCE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

export interface InstantFileEvidence {
	provider: string;
	files: ProviderFile[];
	/** Union of tokens parsed from video file names (no pseudo-code inflation) */
	languages: string[];
	/** Per-file tokens for callers that need per-track detail */
	perFile: Array<{ name: string; languages: string[] }>;
}

const cache = new Map<string, { evidence: InstantFileEvidence | null; expiresAt: number }>();

/** Test seam. */
export function clearInstantEvidenceCache(): void {
	cache.clear();
}

function videoLike(name: string): boolean {
	return /\.(mkv|mp4|avi|mov|m4v|ts|wmv|mpg|mpeg)$/i.test(name);
}

export async function getInstantFileEvidence(
	infoHash: string
): Promise<InstantFileEvidence | null> {
	const key = infoHash.toLowerCase();
	const hit = cache.get(key);
	if (hit && hit.expiresAt > Date.now()) return hit.evidence;

	const evidence = await probe(key);
	cache.set(key, {
		evidence,
		expiresAt: Date.now() + (evidence ? EVIDENCE_TTL_MS : NEGATIVE_TTL_MS)
	});
	return evidence;
}

async function probe(infoHash: string): Promise<InstantFileEvidence | null> {
	try {
		const manager = await getDownloadClientManager();
		const selected = await manager.getDebridClientForAcquisition();
		const adapter = selected?.adapter;
		if (!adapter || typeof adapter.checkInstantFiles !== 'function') return null;

		const files = await adapter.checkInstantFiles(infoHash);
		if (!files || files.length === 0) return null;

		const perFile = files.map((file) => ({
			name: file.name,
			languages: extractLanguagesFromFileName(file.name).languages
		}));
		const seen = new Set<string>();
		const languages: string[] = [];
		// Only video files speak for audio tracks; sidecar names are subtitle
		// evidence and stay out of the headline union.
		for (const file of perFile) {
			if (!videoLike(file.name)) continue;
			for (const tag of file.languages) {
				if (tag === 'multi' || tag === 'orig' || seen.has(tag)) continue;
				seen.add(tag);
				languages.push(tag);
			}
		}

		return { provider: adapter.provider, files, languages, perFile };
	} catch (error) {
		logger.debug(
			{
				infoHash,
				error: error instanceof Error ? error.message : String(error)
			},
			'Instant file evidence probe failed (best-effort, ignored)'
		);
		return null;
	}
}
