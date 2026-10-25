import * as m from '#lib/paraglide/messages.js';
import type { SmartReleaseLineResult } from './smartReleaseLine.js';

/**
 * Render a {@link SmartReleaseLineResult} into a localized string.
 *
 * Kept separate from `smartReleaseLine.ts` so the classification logic stays
 * pure and unit-testable without the generated Paraglide messages.
 */
export function formatReleaseLine(result: SmartReleaseLineResult): string {
	const days = result.params?.days ?? 0;
	switch (result.key) {
		case 'inTheaters':
			return m.common_inTheaters();
		case 'released':
			return m.common_released();
		case 'comingToTheaters':
			return m.common_comingToTheaters({ days });
		case 'availableDigital':
			return m.common_availableDigital();
		case 'availablePhysical':
			return m.common_availablePhysical();
		case 'availableStreaming':
			return m.common_availableStreaming();
		case 'digitalInDays':
			return m.common_digitalInDays({ days });
		case 'physicalInDays':
			return m.common_physicalInDays({ days });
		case 'streamingInDays':
			return m.common_streamingInDays({ days });
		case 'announced':
			return m.common_announced();
	}
}
