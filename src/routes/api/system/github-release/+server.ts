import type { RequestHandler } from './$types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { ensureVersionPrefix } from '#lib/version.js';

const logger = createChildLogger({ logDomain: 'system' as const });

const GITHUB_REPO = 'Cinephage/Cinephage';
const GITHUB_API_BASE = 'https://api.github.com';

interface CachedRelease {
	version: string;
	commit: string;
	fetchedAt: number;
}

let cached: CachedRelease | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchLatestRelease(): Promise<CachedRelease> {
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached;
	}

	const headers: Record<string, string> = {
		Accept: 'application/vnd.github.v3+json',
		'User-Agent': 'Cinephage/1.0'
	};

	const releaseRes = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`, {
		headers
	});

	if (!releaseRes.ok) {
		if (cached) {
			logger.warn(
				{ status: releaseRes.status },
				'GitHub release fetch failed, returning cached data'
			);
			return cached;
		}
		throw new Error(`GitHub releases API returned ${releaseRes.status}`);
	}

	const release = (await releaseRes.json()) as { tag_name: string };
	const tagName = release.tag_name;
	const version = ensureVersionPrefix(tagName);

	const refRes = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/git/ref/tags/${tagName}`, {
		headers
	});

	let commit = 'unknown';
	if (refRes.ok) {
		const ref = (await refRes.json()) as { object?: { sha?: string } };
		if (ref.object?.sha) {
			commit = ref.object.sha.substring(0, 7);
		}
	} else {
		logger.warn({ status: refRes.status }, 'Failed to resolve tag commit SHA');
		if (cached) return { ...cached, fetchedAt: Date.now() };
	}

	cached = { version, commit, fetchedAt: Date.now() };
	return cached;
}

export const GET: RequestHandler = async () => {
	try {
		const release = await fetchLatestRelease();
		return Response.json(
			{ success: true, ...release },
			{
				headers: {
					'cache-control': 'no-store, no-cache, must-revalidate'
				}
			}
		);
	} catch (err) {
		logger.error({ err }, 'Failed to fetch latest GitHub release');
		return Response.json(
			{ success: false, error: 'Failed to fetch release info' },
			{ status: 502 }
		);
	}
};
