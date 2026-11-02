import { blocklistService } from '#lib/server/blocklist/BlocklistService.js';
import { reject, accept } from './types.js';
import type { SpecificationResult, ReleaseCandidate } from './types.js';

export { blocklistService } from '#lib/server/blocklist/BlocklistService.js';
export type { BlocklistReason } from '#lib/server/blocklist/BlocklistService.js';

export class ReleaseBlocklistSpecification {
	private movieId?: string;
	private seriesId?: string;

	constructor(options: { movieId?: string; seriesId?: string }) {
		this.movieId = options.movieId;
		this.seriesId = options.seriesId;
	}

	async isSatisfied(release: ReleaseCandidate): Promise<SpecificationResult> {
		const result = await blocklistService.isBlocklisted(release, {
			movieId: this.movieId,
			seriesId: this.seriesId
		});

		if (result.blocked) {
			return reject(result.reason || 'Release is blocklisted');
		}

		return accept();
	}
}
