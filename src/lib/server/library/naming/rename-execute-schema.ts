import { z } from 'zod';

/**
 * Request schema for POST /api/rename/execute.
 *
 * Lives outside +server.ts because SvelteKit only permits route handlers
 * (GET/POST/...) as exports from endpoint modules.
 */
export const renameExecuteSchema = z.object({
	fileIds: z
		.array(z.string())
		.min(1, 'fileIds array is required and must not be empty')
		.max(500, 'A maximum of 500 files can be renamed per batch'),
	mediaType: z.enum(['movie', 'episode', 'music', 'mixed']).optional().default('mixed')
});
