import type { NewReleaseEvent, ReleaseKind, ReleaseMediaType, ReleaseSource } from '../types.js';

/**
 * A release provider owns a set of release kinds and may only ever write those
 * kinds. TMDB owns theatrical/digital/physical/tv windows; a broadcast provider
 * (TVDB) owns `broadcast`. This is what stops a second source from overwriting
 * the first one's data when both are enabled.
 */
export interface ReleaseProvider {
	id: ReleaseSource;
	supportedMediaTypes: readonly ReleaseMediaType[];
	authority: readonly ReleaseKind[];
	isConfigured(): Promise<boolean>;
	fetch(ref: ReleaseProviderRef, options: ReleaseProviderFetchOptions): Promise<NewReleaseEvent[]>;
}

export interface ReleaseProviderRef {
	mediaType: ReleaseMediaType;
	mediaId: string;
	tmdbId?: number | null;
	tvdbId?: number | null;
}

export interface ReleaseProviderFetchOptions {
	region: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface ReleaseProviderRegistry {
	providers: ReleaseProvider[];
}

/**
 * Providers are resolved per call (not cached in a singleton) so a settings
 * change takes effect immediately — the same convention as
 * `metadata/provider-registry.ts`.
 */
export async function buildReleaseProviderRegistry(): Promise<ReleaseProviderRegistry> {
	const { TmdbReleaseProvider } = await import('./tmdb.js');
	return { providers: [new TmdbReleaseProvider()] };
}
