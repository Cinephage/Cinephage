import type { PageServerLoad } from './$types';
import { loadStorageLayoutData } from '#lib/server/settings/layout-data.js';

export const load: PageServerLoad = async () => {
	return await loadStorageLayoutData();
};
