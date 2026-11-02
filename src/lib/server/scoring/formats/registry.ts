/**
 * Format Registry
 *
 * Merges built-in formats with enabled DB custom formats at runtime.
 * Custom formats participate in live scoring once enabled.
 *
 * Usage:
 *   import { getActiveFormats, invalidateFormatCache } from './registry.js';
 *
 *   // Get all active formats for scoring
 *   const formats = getActiveFormats();
 *
 *   // After custom format CRUD, invalidate so next call rebuilds cache
 *   invalidateFormatCache();
 */

import type { CustomFormat, ConditionType, FormatCondition } from '../types.js';
import { ALL_FORMATS } from './index.js';
import { db } from '#lib/server/db/index.js';
import { customFormats } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

let _activeFormats: CustomFormat[] | null = null;
const logger = createChildLogger({ module: 'FormatRegistry', component: 'FormatRegistry' });

/**
 * Map a database custom format record to a runtime CustomFormat
 */
function mapDbToFormat(row: typeof customFormats.$inferSelect): CustomFormat {
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? '',
		category: row.category as CustomFormat['category'],
		tags: row.tags ?? [],
		conditions: (row.conditions ?? []).map(
			(c) => ({ ...c, type: c.type as ConditionType }) as FormatCondition
		)
	};
}

/**
 * Get all active formats: built-in + enabled DB custom formats.
 * Results are cached until invalidated.
 */
export function getActiveFormats(): CustomFormat[] {
	if (_activeFormats !== null) {
		return _activeFormats;
	}

	try {
		const dbCustomFormats = db
			.select()
			.from(customFormats)
			.where(eq(customFormats.enabled, true))
			.all();

		_activeFormats = [...ALL_FORMATS, ...dbCustomFormats.map(mapDbToFormat)];
		return _activeFormats;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('no such table: custom_formats')) {
			// Schema sync may not have run yet in isolated unit tests.
			// Fall back to built-in formats rather than failing quality comparisons.
			logger.warn('custom_formats table unavailable, falling back to built-in formats');
			_activeFormats = ALL_FORMATS;
			return _activeFormats;
		}
		throw error;
	}
}

/**
 * Invalidate the format cache.
 * Call this after custom format create, update, or delete.
 */
export function invalidateFormatCache(): void {
	_activeFormats = null;
}
