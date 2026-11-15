import type { GrabDecisionOptions } from './types.js';

/**
 * The hard gates (blocklist, duplicate hash, media occupancy) exist to keep the
 * app from spending its own budget on something it should not have. A manual
 * grab is the user's decision, so they do not apply to it: the release was
 * picked deliberately, and "a file already exists / this hash was imported /
 * this is blocklisted" is not a reason to refuse it. Automatic grabs keep every
 * gate.
 *
 * Slot exclusivity is deliberately not a stage concern: it lives in
 * AcquisitionService, so a manual grab still cannot start a second acquisition
 * for a slot that is already downloading.
 */
export function skipsHardStages(
	options: Pick<GrabDecisionOptions, 'overrideHardStages' | 'isAutomatic'>
): boolean {
	return options.overrideHardStages === true || options.isAutomatic === false;
}
