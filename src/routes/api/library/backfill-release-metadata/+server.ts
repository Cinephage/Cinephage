import { backfillReleaseMetadata } from '#lib/server/library/release-metadata-backfill.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({
	module: 'LibraryBackfillReleaseMetadataApi',
	logDomain: 'scans'
});

export async function POST({ request }: { request: Request }) {
	try {
		const body = await request.json().catch(() => ({}));
		const apply = body?.apply === true;
		const sampleLimit = typeof body?.sampleLimit === 'number' ? body.sampleLimit : 50;

		logger.info({ apply, sampleLimit }, '[API] Starting release metadata backfill');
		const result = await backfillReleaseMetadata({ apply, sampleLimit });

		return Response.json({
			success: true,
			...result
		});
	} catch (error) {
		logger.error(
			'[API] Release metadata backfill failed',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
}
