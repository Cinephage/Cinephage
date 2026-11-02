import * as m from '#lib/paraglide/messages.js';
import { RELEASE_TYPE } from './releaseTypes.js';

const LABELS: Record<number, () => string> = {
	[RELEASE_TYPE.PREMIERE]: () => m.hero_releaseType_premiere(),
	[RELEASE_TYPE.THEATRICAL_LIMITED]: () => m.hero_releaseType_limitedTheatrical(),
	[RELEASE_TYPE.THEATRICAL]: () => m.hero_releaseType_theatrical(),
	[RELEASE_TYPE.DIGITAL]: () => m.hero_releaseType_digital(),
	[RELEASE_TYPE.PHYSICAL]: () => m.hero_releaseType_physical(),
	[RELEASE_TYPE.TV]: () => m.hero_releaseType_tv()
};

/** Localized label for a TMDB release `type` number (1-6). */
export function releaseTypeLabel(type: number): string {
	return LABELS[type]?.() ?? '';
}
