import type { RequestHandler } from './$types';
import { parseRelease, evaluateCondition } from '#lib/server/scoring/index.js';
import type { FormatCondition } from '#lib/server/scoring/index.js';
import { customFormatTestSchema } from '#lib/validation/schemas.js';
import { logger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

/**
 * POST /api/custom-formats/test
 * Test format conditions against a release name
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const body = await request.json();
		const validation = customFormatTestSchema.safeParse(body);

		if (!validation.success) {
			return Response.json(
				{ error: 'Invalid request body', details: validation.error.issues },
				{ status: 400 }
			);
		}

		const { releaseName, conditions } = validation.data;

		// Parse the release name - returns ReleaseAttributes directly
		const attributes = parseRelease(releaseName);

		// Evaluate each condition
		const requiredConditions: { condition: FormatCondition; matched: boolean }[] = [];
		const optionalConditions: { condition: FormatCondition; matched: boolean }[] = [];

		for (const condition of conditions as FormatCondition[]) {
			const result = evaluateCondition(condition, attributes);
			const entry = { condition, matched: result.matches };

			if (condition.required) {
				requiredConditions.push(entry);
			} else {
				optionalConditions.push(entry);
			}
		}

		// Determine overall match
		const allRequiredMatch = requiredConditions.every((r) => r.matched);
		const anyOptionalMatch =
			optionalConditions.length === 0 || optionalConditions.some((r) => r.matched);
		const matched = allRequiredMatch && anyOptionalMatch;

		// Count results
		const matchedConditions = [...requiredConditions, ...optionalConditions].filter(
			(r) => r.matched
		).length;
		const failedConditions = requiredConditions.filter((r) => !r.matched).length;

		return Response.json({
			matched,
			totalConditions: conditions.length,
			matchedConditions,
			failedConditions,
			// Parsed attributes for reference
			parsedAttributes: {
				resolution: attributes.resolution,
				source: attributes.source,
				codec: attributes.codec,
				hdr: attributes.hdr,
				audioCodec: attributes.audioCodec,
				audioChannels: attributes.audioChannels,
				hasAtmos: attributes.hasAtmos,
				releaseGroup: attributes.releaseGroup,
				streamingService: attributes.streamingService,
				isRemux: attributes.isRemux,
				isRepack: attributes.isRepack,
				isProper: attributes.isProper,
				is3d: attributes.is3d
			},
			// Detailed condition results
			conditionResults: [...requiredConditions, ...optionalConditions].map((r) => ({
				name: r.condition.name,
				type: r.condition.type,
				required: r.condition.required,
				negate: r.condition.negate,
				matched: r.matched
			}))
		});
	} catch (error) {
		logger.error('Error testing format:', error);
		return Response.json({ error: 'Test failed' }, { status: 500 });
	}
};
