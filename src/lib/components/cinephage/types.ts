import type { CinephageSubsystemState } from '#lib/api/index.js';

/** Config slice as provided by the /settings/system/cinephage server load. */
export type CinephageConfigView = CinephageSubsystemState['config'];

/** Resolved server identity as provided by the page server load. */
export type CinephageIdentityView = CinephageSubsystemState['identity'];

/** Module row from the page server load — adds the runtime-effective enabled state. */
export type CinephageModuleView = CinephageSubsystemState['modules'][number] & {
	effectiveEnabled: boolean;
};
