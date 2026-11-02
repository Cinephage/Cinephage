/**
 * HLS Playlist Parser & Validator
 *
 * Parses HLS master playlists, selects quality variants,
 * and validates/sanitizes playlist content.
 */

import { logger } from '#lib/logging/index.js';

const streamLog = { logDomain: 'streams' as const };

// ============================================================================
// Playlist Validation
// ============================================================================

/**
 * Result of playlist validation
 */
export interface PlaylistValidation {
	valid: boolean;
	type: 'master' | 'media' | 'unknown';
	errors: string[];
	warnings: string[];
}

/**
 * Validate that content is a valid HLS playlist
 */
export function validatePlaylist(content: string): PlaylistValidation {
	const result: PlaylistValidation = {
		valid: false,
		type: 'unknown',
		errors: [],
		warnings: []
	};

	if (!content || content.trim().length === 0) {
		result.errors.push('Empty content');
		return result;
	}

	const lines = content.trim().split('\n');

	// Must start with #EXTM3U
	const firstLine = lines[0]?.trim();
	if (!firstLine?.startsWith('#EXTM3U')) {
		result.errors.push('Missing #EXTM3U header');
		return result;
	}

	// Detect playlist type
	const hasMasterTags = content.includes('#EXT-X-STREAM-INF');
	const hasMediaTags = content.includes('#EXTINF:');

	if (hasMasterTags && hasMediaTags) {
		result.warnings.push('Playlist contains both master and media tags');
	}

	if (hasMasterTags) {
		result.type = 'master';
		// Validate master playlist
		const streamInfCount = (content.match(/#EXT-X-STREAM-INF/g) || []).length;
		if (streamInfCount === 0) {
			result.errors.push('Master playlist has no variants');
		}
	} else if (hasMediaTags) {
		result.type = 'media';
		// Validate media playlist
		const segmentCount = (content.match(/#EXTINF:/g) || []).length;
		if (segmentCount === 0) {
			result.errors.push('Media playlist has no segments');
		}

		// Check for ENDLIST in VOD playlists
		if (!content.includes('#EXT-X-ENDLIST')) {
			result.warnings.push('Media playlist missing #EXT-X-ENDLIST (may be treated as live)');
		}
	} else {
		result.errors.push('Playlist has no recognizable HLS tags');
	}

	result.valid = result.errors.length === 0;
	return result;
}

/**
 * Sanitize a potentially corrupted playlist
 * Removes garbage content before/after HLS data
 */
export function sanitizePlaylist(content: string): string {
	if (!content) return content;

	// Find where #EXTM3U starts (remove any garbage before it)
	const extm3uIndex = content.indexOf('#EXTM3U');
	if (extm3uIndex > 0) {
		content = content.substring(extm3uIndex);
		logger.debug(
			{
				removedBytes: extm3uIndex,
				...streamLog
			},
			'HLS removed garbage before #EXTM3U'
		);
	} else if (extm3uIndex === -1) {
		// No #EXTM3U found, return as-is
		return content;
	}

	// Process lines and keep only valid HLS content
	const lines = content.split('\n');
	const sanitized: string[] = [];
	let foundEndlist = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Stop after #EXT-X-ENDLIST (ignore trailing garbage)
		if (trimmed === '#EXT-X-ENDLIST') {
			sanitized.push(line);
			foundEndlist = true;
			break;
		}

		// Keep HLS tags
		if (trimmed.startsWith('#')) {
			sanitized.push(line);
			continue;
		}

		// Keep URLs (absolute or relative)
		if (
			trimmed.startsWith('http://') ||
			trimmed.startsWith('https://') ||
			trimmed.startsWith('/') ||
			/^[a-zA-Z0-9_\-./]+(\?.*)?$/.test(trimmed)
		) {
			sanitized.push(line);
			continue;
		}

		// Keep empty lines (formatting)
		if (trimmed === '') {
			sanitized.push(line);
			continue;
		}

		// Skip unrecognized content
		logger.debug({ line: trimmed.substring(0, 50), ...streamLog }, 'HLS sanitizer skipped line');
	}

	// If we stopped at ENDLIST but there was content after, log it
	if (foundEndlist && lines.length > sanitized.length) {
		logger.debug(
			{
				removedLines: lines.length - sanitized.length,
				...streamLog
			},
			'HLS removed content after #EXT-X-ENDLIST'
		);
	}

	return sanitized.join('\n');
}

/**
 * Check if content looks like an HLS playlist (quick check)
 */
export function isHLSPlaylist(content: string): boolean {
	if (!content) return false;
	const start = content.trimStart().substring(0, 100);
	return start.startsWith('#EXTM3U');
}
