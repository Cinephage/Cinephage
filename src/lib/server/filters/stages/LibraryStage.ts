import { enrichWithLibraryStatus, filterInLibrary } from '#lib/server/library/status.js';
import type { FilterStage, FilterContext } from '../types.js';

export class LibraryStage implements FilterStage<
	{ id: number; media_type?: string },
	FilterContext
> {
	name = 'library';

	isEnabled(_ctx: FilterContext): boolean {
		return true;
	}

	async apply<T extends { id: number; media_type?: string }>(
		items: T[],
		ctx: FilterContext
	): Promise<T[]> {
		if (!items || items.length === 0) return items ?? [];

		const enriched = await enrichWithLibraryStatus(items, ctx.mediaType);

		if (ctx.excludeInLibrary) {
			return filterInLibrary(enriched, true);
		}

		return enriched as T[];
	}
}
