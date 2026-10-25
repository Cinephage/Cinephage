import { buildMetadataProviderRegistry } from './provider-registry.js';
import type { MetadataProviderId, MetadataSearchResult } from './providers/types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'ProviderRefResolver', logDomain: 'system' });

type AnimeProviderId = Extract<MetadataProviderId, 'anilist' | 'mal'>;

export interface ResolveProviderRefsInput {
	title: string;
	aliases?: string[];
	year?: number | null;
	isAnime: boolean;
	configured: Record<AnimeProviderId, boolean>;
	existingRefs?: Partial<Record<MetadataProviderId, string>> | null;
}

// Unicode-aware: strip everything but letters/numbers from ANY script, not
// just ASCII. A plain [^a-z0-9] filter silently destroys non-Latin text
// (Japanese, etc.) down to nothing (or whatever stray digits survive),
// which would make two completely unrelated titles that merely share a
// number (e.g. "0083") look identical - exactly the native-title
// comparison this module relies on for anime, where source titles are
// Japanese.
function normalize(value: string): string {
	return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Split on word boundaries FIRST, then let each token through normalize's
// character filter - not the other way around. Calling normalize() on the
// whole string before splitting removes the spaces/punctuation that mark
// word boundaries, leaving one giant token with nothing left to split on,
// which made token-overlap scoring silently degrade to all-or-nothing
// whole-string equality instead of genuine partial overlap.
function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/gu)
		.filter(Boolean);
}

function tokenOverlapScore(a: string, b: string): number {
	const aTokens = new Set(tokens(a));
	const bTokens = new Set(tokens(b));
	if (aTokens.size === 0 || bTokens.size === 0) return 0;
	let shared = 0;
	for (const token of aTokens) {
		if (bTokens.has(token)) shared += 1;
	}
	return shared / Math.max(aTokens.size, bTokens.size);
}

const INCLUDES_MIN_LEN = 4;

function pickBestMatch(
	results: MetadataSearchResult[],
	titles: string[],
	year?: number | null
): { result: MetadataSearchResult; confidence: 'high' | 'low' } | null {
	if (results.length === 0) return null;
	const normalizedTargets = titles.map((title) => normalize(title)).filter(Boolean);
	const plainTargets = titles.filter((title) => title.trim().length > 0);
	if (normalizedTargets.length === 0) return null;

	const candidates = results.map((result) => {
		const normalizedTitle = normalize(result.title);
		const yearDelta =
			typeof year === 'number' && typeof result.year === 'number'
				? Math.abs(year - result.year)
				: null;
		// Native/original title is included as an exact-match signal too: AniList's
		// `native` and Jikan's `title_japanese` are canonical and far more stable
		// across sources than the English title, which varies a lot between
		// providers (e.g. a leading "The", alternate translations/synonyms) and
		// can otherwise keep an objectively correct match stuck at 'low'
		// confidence. We already carry our own original title as one of
		// `titles` (see resolveMissingAnimeProviderRefs' aliases), so this is
		// just comparing it against the candidate's native title too.
		const normalizedOriginal = result.originalTitle ? normalize(result.originalTitle) : '';
		const nativeExact =
			normalizedOriginal.length > 0 &&
			normalizedTargets.some((target) => normalizedOriginal === target);
		const exact = nativeExact || normalizedTargets.some((target) => normalizedTitle === target);
		// Bidirectional includes: both sides must meet minimum length to avoid trivial matches
		const includes = normalizedTargets.some((target) => {
			if (!target || target.length < INCLUDES_MIN_LEN || normalizedTitle.length < INCLUDES_MIN_LEN)
				return false;
			return normalizedTitle.includes(target) || target.includes(normalizedTitle);
		});
		const overlap = plainTargets.length
			? Math.max(...plainTargets.map((target) => tokenOverlapScore(result.title, target)))
			: 0;
		// Heavier year penalty when delta > 1 to push mismatched years down rankings
		const yearPenalty = yearDelta !== null ? (yearDelta > 1 ? yearDelta * 50 : yearDelta) : 0;
		const score =
			(exact ? 1000 : 0) + (includes ? 200 : 0) + Math.round(overlap * 100) - yearPenalty;
		return { result, score, yearDelta, exact, includes, overlap };
	});
	candidates.sort((a, b) => b.score - a.score);

	const best = candidates[0];
	if (!best) return null;
	const withinYear = typeof best.yearDelta !== 'number' || best.yearDelta <= 1;
	const strongTextMatch = best.exact || best.includes || best.overlap >= 0.7;
	if (!strongTextMatch || !withinYear) return null;

	// Runner-up margin: if the second candidate is close and we have no exact match, downgrade confidence
	const runnerUp = candidates[1];
	const ambiguous = !best.exact && runnerUp !== undefined && best.score - runnerUp.score < 150;
	const confidence: 'high' | 'low' =
		best.exact || (best.overlap >= 0.8 && !ambiguous && withinYear) ? 'high' : 'low';

	return { result: best.result, confidence };
}

export async function resolveAnimeProviderRef(input: {
	providerId: AnimeProviderId;
	title: string;
	aliases?: string[];
	year?: number | null;
}): Promise<string | undefined> {
	const queryVariants = [...new Set([input.title, ...(input.aliases ?? [])])]
		.map((value) => value.trim())
		.filter(Boolean);
	if (queryVariants.length === 0) return undefined;

	const { providers } = await buildMetadataProviderRegistry();
	const provider = providers.get(input.providerId);
	if (!provider?.isConfigured()) return undefined;

	for (const query of queryVariants) {
		try {
			const results = await provider.searchTitle(query, 'anime');
			const best = pickBestMatch(results, queryVariants, input.year);
			if (best?.confidence === 'high' && best.result.id) {
				logger.debug(
					{
						providerId: input.providerId,
						query,
						matchedTitle: best.result.title,
						matchedId: best.result.id
					},
					'[ProviderRefResolver] Matched anime provider ref'
				);
				return String(best.result.id);
			}
			// Diagnostic only - this isn't an error was it zero results,
			// or a candidate that scored too low/
			// ambiguous to trust? (resolveMissingAnimeProviderRefs only accepts
			// 'high' confidence, so a 'low' candidate here is silently skipped.)
			logger.debug(
				{
					providerId: input.providerId,
					query,
					resultCount: results.length,
					bestCandidateTitle: best?.result.title,
					bestCandidateConfidence: best?.confidence
				},
				'[ProviderRefResolver] No confident anime provider match for query variant'
			);
		} catch (err) {
			logger.debug(
				{
					providerId: input.providerId,
					query,
					error: err instanceof Error ? err.message : String(err)
				},
				'[ProviderRefResolver] Query variant failed, trying next'
			);
		}
	}

	return undefined;
}

export async function resolveMissingAnimeProviderRefs(
	input: ResolveProviderRefsInput
): Promise<Partial<Record<MetadataProviderId, string>>> {
	const baseRefs: Partial<Record<MetadataProviderId, string>> = { ...(input.existingRefs ?? {}) };
	if (!input.isAnime || !input.title?.trim()) return baseRefs;

	const wantedProviders: AnimeProviderId[] = (['anilist', 'mal'] as const).filter(
		(providerId) => input.configured[providerId] && !baseRefs[providerId]
	);
	if (wantedProviders.length === 0) return baseRefs;
	const queryVariants = [...new Set([input.title, ...(input.aliases ?? [])])]
		.map((value) => value.trim())
		.filter(Boolean);
	if (queryVariants.length === 0) return baseRefs;

	// resolveAnimeProviderRef tries each query variant (title + aliases)
	// sequentially, and every variant hits a real upstream fetch (each already
	// individually timed out, see anilist.ts/mal.ts). With more than one
	// variant those per-fetch timeouts can still stack up, and this whole call
	// sits directly on the series page's SSR critical path, so cap the total
	// time per provider rather than trust the per-fetch timeouts alone. A
	// timeout here just means this load's enrichment is skipped, not an error,
	// existing refs are kept and the next page load tries again.
	const PER_PROVIDER_TIMEOUT_MS = 8000;

	await Promise.all(
		wantedProviders.map(async (providerId) => {
			const ref = await Promise.race([
				resolveAnimeProviderRef({
					providerId,
					title: input.title,
					aliases: input.aliases,
					year: input.year
				}),
				new Promise<undefined>((resolve) =>
					setTimeout(() => resolve(undefined), PER_PROVIDER_TIMEOUT_MS)
				)
			]);
			if (ref) baseRefs[providerId] = ref;
		})
	);

	return baseRefs;
}
