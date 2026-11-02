import type { PageServerLoad } from './$types';
import { getBlockedVideoExtensions } from '#lib/server/settings/blocked-extensions.js';

export const load: PageServerLoad = async () => {
	const settings = await getBlockedVideoExtensions();
	return { extensions: settings.extensions };
};
