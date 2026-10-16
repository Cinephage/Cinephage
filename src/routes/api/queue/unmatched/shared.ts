/**
 * Shared validation + handling for the unmatched POST actions (track,
 * enroll). One schema base, one responder — `requests/bulk`-style:
 * `{ pairs }` in, per-pair outcomes out. URLs stay separate; only the
 * boilerplate is shared.
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const unmatchedPairFields = {
	hash: z.string().min(1),
	mediaType: z.enum(['movie', 'tv']),
	tmdbId: z.number().int().positive(),
	seasonNumber: z.number().int().min(0).max(99).nullish()
};

export const trackBodySchema = z.object({
	pairs: z.array(z.object(unmatchedPairFields)).min(1).max(100)
});

export const enrollBodySchema = z.object({
	pairs: z
		.array(
			z.object({
				...unmatchedPairFields,
				rootFolderId: z.string().min(1).nullish()
			})
		)
		.min(1)
		.max(100)
});

export type TrackPairs = z.infer<typeof trackBodySchema>['pairs'];
export type EnrollPairs = z.infer<typeof enrollBodySchema>['pairs'];

interface PairOutcome {
	tracked?: { hash: string; queueId: string }[];
	enrolled?: { hash: string; queueId: string }[];
	skipped: { hash: string; reason: string }[];
}

export async function handleUnmatchedPost(
	event: { request: Request; locals: App.Locals },
	config: {
		logModule: string;
		verb: 'tracked' | 'enrolled';
		schema: typeof trackBodySchema | typeof enrollBodySchema;
		run: (pairs: TrackPairs | EnrollPairs) => Promise<PairOutcome>;
	}
) {
	// Defense-in-depth: the hooks viewer gate confines these routes; this
	// guard keeps them admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(event.locals);
	if (authError) return authError;

	let pairs: TrackPairs | EnrollPairs;
	try {
		pairs = config.schema.parse(await event.request.json()).pairs;
	} catch {
		return json({ success: false, error: 'Invalid request body' }, { status: 400 });
	}

	const logger = createChildLogger({ module: config.logModule, logDomain: 'downloads' });
	try {
		const result = await config.run(pairs);
		const done = (config.verb === 'tracked' ? result.tracked : result.enrolled) ?? [];
		return json({
			success: true,
			[config.verb]: done.length,
			skipped: result.skipped,
			details: [...done, ...result.skipped]
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error({ error: message }, `Unmatched ${config.verb} failed`);
		return json({ success: false, error: message }, { status: 500 });
	}
}
