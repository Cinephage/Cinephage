import type { LayoutServerLoad } from './$types';
import { loadStorageLayoutData } from '#lib/server/settings/layout-data.js';

export const load: LayoutServerLoad = async () => {
	return await loadStorageLayoutData();
};
