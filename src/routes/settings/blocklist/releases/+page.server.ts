import type { PageServerLoad } from './$types';
import { blocklistService } from '#lib/server/monitoring/specifications/BlocklistSpecification.js';

export const load: PageServerLoad = async () => {
	const [entries, total] = await Promise.all([
		blocklistService.getBlocklist({ limit: 100, offset: 0 }),
		blocklistService.getBlocklistCount()
	]);

	return { entries, total };
};
