/**
 * NZB Validation Service - Validates NZB file structure before sending to download client.
 * Follows the pattern from Prowlarr's NzbValidationService.cs.
 */

import * as cheerio from 'cheerio';
import { InvalidNzbError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

/**
 * Result of NZB validation.
 */
export interface NzbValidationResult {
	/** Whether the NZB is valid */
	valid: boolean;
	/** Error message if invalid */
	error?: string;
	/** Number of files in the NZB */
	fileCount?: number;
	/** Total size in bytes (estimated from segment sizes) */
	totalSize?: number;
	/** Usenet groups referenced in the NZB */
	groups?: string[];
}

/**
 * Service for validating NZB file content.
 */
export class NzbValidationService {
	/**
	 * Validate NZB XML structure.
	 * @param content - NZB file content as Buffer or string
	 * @returns Validation result with metadata if valid
	 * @throws InvalidNzbError if the NZB is invalid and throwOnError is true
	 */
	validate(content: Buffer | string, throwOnError: boolean = false): NzbValidationResult {
		try {
			const xml = typeof content === 'string' ? content : content.toString('utf-8');

			// Quick check for empty content
			if (!xml.trim()) {
				const result = { valid: false, error: 'NZB content is empty' };
				if (throwOnError) throw new InvalidNzbError(result.error);
				return result;
			}

			const $ = cheerio.load(xml, { xmlMode: true });

			// Check for error response from indexer (common pattern)
			const errorEl = $('error');
			if (errorEl.length > 0) {
				const code = errorEl.attr('code') || 'unknown';
				const desc = errorEl.attr('description') || errorEl.text() || 'Unknown error';
				const error = `Indexer error ${code}: ${desc}`;

				logger.warn({ code, desc }, '[NzbValidation] Received error response instead of NZB');

				const result = { valid: false, error };
				if (throwOnError) throw new InvalidNzbError(error, { code });
				return result;
			}

			// Check for root <nzb> element
			const root = $('nzb');
			if (root.length === 0) {
				const error = 'Invalid NZB: No root <nzb> element found';
				logger.warn({ error }, '[NzbValidation] Invalid NZB structure');

				const result = { valid: false, error };
				if (throwOnError) throw new InvalidNzbError(error);
				return result;
			}

			// Check for at least one <file> element
			const files = root.find('file');
			if (files.length === 0) {
				const error = 'Invalid NZB: No <file> elements found';
				logger.warn({ error }, '[NzbValidation] NZB has no files');

				const result = { valid: false, error };
				if (throwOnError) throw new InvalidNzbError(error);
				return result;
			}

			// Calculate total size and collect groups
			let totalSize = 0;
			const groups = new Set<string>();

			files.each((_, file) => {
				// Get groups for this file
				$(file)
					.find('groups group')
					.each((_, groupEl) => {
						const groupName = $(groupEl).text().trim();
						if (groupName) {
							groups.add(groupName);
						}
					});

				// Sum up segment sizes
				$(file)
					.find('segments segment')
					.each((_, segment) => {
						const bytes = parseInt($(segment).attr('bytes') || '0', 10);
						if (!isNaN(bytes)) {
							totalSize += bytes;
						}
					});
			});

			logger.debug(
				{
					fileCount: files.length,
					totalSize,
					groupCount: groups.size
				},
				'[NzbValidation] NZB validated successfully'
			);

			return {
				valid: true,
				fileCount: files.length,
				totalSize,
				groups: Array.from(groups)
			};
		} catch (error) {
			// Re-throw InvalidNzbError
			if (error instanceof InvalidNzbError) {
				throw error;
			}

			const message = `Failed to parse NZB: ${error instanceof Error ? error.message : 'Unknown error'}`;
			logger.error({ err: error }, '[NzbValidation] Parse error');

			const result = { valid: false, error: message };
			if (throwOnError) throw new InvalidNzbError(message);
			return result;
		}
	}

	/**
	 * Validate NZB and throw if invalid.
	 * Convenience method for use in grab flows.
	 */
	validateOrThrow(content: Buffer | string): NzbValidationResult {
		return this.validate(content, true);
	}

	/**
	 * Check if content looks like an NZB (quick check without full parsing).
	 */
	isNzbContent(content: Buffer | string): boolean {
		const str = typeof content === 'string' ? content : content.toString('utf-8');
		const lower = str.toLowerCase();
		return lower.includes('<nzb') && lower.includes('<file');
	}
}

/** Singleton instance */
let instance: NzbValidationService | null = null;

/**
 * Get the singleton NzbValidationService instance.
 */
export function getNzbValidationService(): NzbValidationService {
	if (!instance) {
		instance = new NzbValidationService();
	}
	return instance;
}
