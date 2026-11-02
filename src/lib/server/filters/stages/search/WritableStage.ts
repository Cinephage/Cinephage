import type { DecisionStage, StageResult } from '../../types.js';
import type { SearchEligibilityContext } from './types.js';
import { db } from '#lib/server/db/index.js';
import { rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export class WritableStage implements DecisionStage<SearchEligibilityContext> {
	name = 'writable';

	isEnabled(ctx: SearchEligibilityContext): boolean {
		return !ctx.options.forceSearch;
	}

	async evaluate(ctx: SearchEligibilityContext): Promise<StageResult> {
		const folderId = ctx.episode ? ctx.series?.rootFolderId : ctx.media.rootFolderId;

		if (!folderId) {
			return { accepted: true };
		}

		const folder = db
			.select({ readOnly: rootFolders.readOnly })
			.from(rootFolders)
			.where(eq(rootFolders.id, folderId))
			.get();

		if (folder?.readOnly) {
			return { accepted: false, reason: 'Root folder is read-only' };
		}

		return { accepted: true };
	}
}
