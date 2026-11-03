import { resolveReleaseStage } from './releaseStage.js';

export type ReleaseLineVariant = 'released' | 'upcoming' | 'theaters' | 'announced';

export type ReleaseLineKey =
	| 'inTheaters'
	| 'released'
	| 'comingToTheaters'
	| 'availableDigital'
	| 'availablePhysical'
	| 'availableStreaming'
	| 'digitalInDays'
	| 'physicalInDays'
	| 'streamingInDays'
	| 'announced';

export interface SmartReleaseLineResult {
	/** Translation key - render via `formatReleaseLine` from `releaseLineText.ts`. */
	key: ReleaseLineKey;
	/** Parameters for the translation (currently only a day count). */
	params?: { days: number };
	variant: ReleaseLineVariant;
}

export interface ReleaseLineInput {
	releaseDate: string | null | undefined;
	digitalReleaseDate: string | null | undefined;
	physicalReleaseDate: string | null | undefined;
	tvReleaseDate?: string | null | undefined;
	status?: string | null;
}

function toMs(date: string | null | undefined): number | null {
	return date ? new Date(date).getTime() : null;
}

export function getSmartReleaseLine(
	input: ReleaseLineInput | null | undefined,
	now: Date = new Date()
): SmartReleaseLineResult | null {
	if (!input) return null;

	const stage = resolveReleaseStage(
		{
			theatricalMs: toMs(input.releaseDate),
			digitalMs: toMs(input.digitalReleaseDate),
			physicalMs: toMs(input.physicalReleaseDate),
			tvMs: toMs(input.tvReleaseDate)
		},
		now
	);

	switch (stage.kind) {
		case 'availableDigital':
			return { key: 'availableDigital', variant: 'released' };
		case 'availablePhysical':
			return { key: 'availablePhysical', variant: 'released' };
		case 'availableStreaming':
			return { key: 'availableStreaming', variant: 'released' };
		case 'digitalUpcoming':
			return { key: 'digitalInDays', params: { days: stage.days ?? 0 }, variant: 'upcoming' };
		case 'physicalUpcoming':
			return { key: 'physicalInDays', params: { days: stage.days ?? 0 }, variant: 'upcoming' };
		case 'streamingUpcoming':
			return { key: 'streamingInDays', params: { days: stage.days ?? 0 }, variant: 'upcoming' };
		case 'inTheaters':
			return { key: 'inTheaters', variant: 'theaters' };
		case 'released':
			return { key: 'released', variant: 'released' };
		case 'comingToTheaters':
			return { key: 'comingToTheaters', params: { days: stage.days ?? 0 }, variant: 'upcoming' };
		case 'announced':
			return { key: 'announced', variant: 'announced' };
	}
}
