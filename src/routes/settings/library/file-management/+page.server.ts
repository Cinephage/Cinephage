import type { PageServerLoad } from './$types';
import { getFileManagementSettings } from '#lib/server/settings/file-management.js';
import { getSidecarSettings } from '#lib/server/library/sidecar/sidecarSettings.js';

export const load: PageServerLoad = async () => {
	const settings = await getFileManagementSettings();
	return { settings, sidecarSettings: getSidecarSettings() };
};
