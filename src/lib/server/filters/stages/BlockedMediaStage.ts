import { filterBlockedMedia } from '#lib/server/library/status.js';
import type { FilterStage, FilterContext } from '../types.js';

export class BlockedMediaStage implements FilterStage<
	{ id: number; media_type?: string },
	FilterContext
> {
	name = 'blockedMedia';

	isEnabled(ctx: FilterContext): boolean {
		return !ctx.skipBlockedMedia;
	}

	async apply<T extends { id: number; media_type?: string }>(
		items: T[],
		ctx: FilterContext
	): Promise<T[]> {
		return filterBlockedMedia(items, ctx.mediaType) as Promise<T[]>;
	}
}
