import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { fileManagementSchema, type FileManagementSettings } from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'FileManagement' });
const SETTINGS_KEY = 'file_management';

let cached: FileManagementSettings | null = null;

export async function getFileManagementSettings(): Promise<FileManagementSettings> {
	if (cached) return cached;

	const row = await db.query.settings.findFirst({ where: eq(settings.key, SETTINGS_KEY) });

	if (row?.value) {
		try {
			const parsed = fileManagementSchema.parse(JSON.parse(row.value));
			cached = parsed;
			return parsed;
		} catch {
			logger.warn('Failed to parse file management settings, using defaults');
		}
	}

	const defaults = fileManagementSchema.parse({});
	cached = defaults;
	return defaults;
}

export async function setFileManagementSettings(
	data: FileManagementSettings
): Promise<FileManagementSettings> {
	await db
		.insert(settings)
		.values({ key: SETTINGS_KEY, value: JSON.stringify(data) })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(data) } });

	cached = data;
	return data;
}

export function invalidateFileManagementCache(): void {
	cached = null;
}
