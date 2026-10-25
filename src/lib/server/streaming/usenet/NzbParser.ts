/**
 * NzbParser - Parses NZB files to extract segment information for streaming.
 *
 * Extracts complete file and segment data needed for direct NNTP streaming.
 */

import * as cheerio from 'cheerio';
import { createChildLogger } from '#lib/logging/index.js';
import { createHash } from 'node:crypto';

const logger = createChildLogger({ logDomain: 'streams' as const });
import { isMediaFile, isRarFile, type NzbSegment, type NzbFile, type ParsedNzb } from './types';

/**
 * Extract filename from subject line.
 * Subjects often have format: "description yEnc (1/10) filename.ext"
 */
function extractFilename(subject: string): string {
	// Try to find quoted filename
	const quotedMatch = subject.match(/"([^"]+)"/);
	if (quotedMatch) {
		return quotedMatch[1];
	}

	// Try yEnc format: "... yEnc (1/10) filename.ext"
	const yencMatch = subject.match(/yEnc\s*\(\d+\/\d+\)\s*(.+?)(?:\s*\[|$)/i);
	if (yencMatch) {
		return yencMatch[1].trim();
	}

	// Try to find filename with extension at end
	const extMatch = subject.match(/([^\s/\\]+\.[a-z0-9]{2,4})\s*$/i);
	if (extMatch) {
		return extMatch[1];
	}

	// Fall back to subject itself
	return subject.slice(0, 100);
}

/**
 * Extract RAR part number from filename.
 */
function extractRarPartNumber(filename: string): number | undefined {
	// .part01.rar, .part1.rar
	const partMatch = filename.match(/\.part(\d+)\.rar$/i);
	if (partMatch) {
		return parseInt(partMatch[1], 10);
	}

	// .r00, .r01 etc
	const rMatch = filename.match(/\.r(\d{2})$/i);
	if (rMatch) {
		return parseInt(rMatch[1], 10) + 1; // r00 = part 1
	}

	// .001, .002 etc
	const numMatch = filename.match(/\.(\d{3})$/);
	if (numMatch) {
		return parseInt(numMatch[1], 10);
	}

	// Single .rar is part 1
	if (filename.toLowerCase().endsWith('.rar')) {
		return 1;
	}

	return undefined;
}

/**
 * Parse an NZB file to extract full segment information.
 *
 * @param content - NZB file content (Buffer or string)
 * @returns Parsed NZB with files and segments
 * @throws Error if NZB is invalid
 */
export function parseNzb(content: Buffer | string): ParsedNzb {
	const xml = typeof content === 'string' ? content : content.toString('utf-8');
	const hash = createHash('sha256').update(xml).digest('hex');

	const $ = cheerio.load(xml, { xmlMode: true });
	const root = $('nzb');

	if (root.length === 0) {
		throw new Error('Invalid NZB: No root <nzb> element found');
	}

	const fileElements = root.find('file');
	if (fileElements.length === 0) {
		throw new Error('Invalid NZB: No <file> elements found');
	}

	const files: NzbFile[] = [];
	const allGroups = new Set<string>();
	let totalSize = 0;

	fileElements.each((index, fileEl) => {
		const $file = $(fileEl);

		const poster = $file.attr('poster') || '';
		const date = parseInt($file.attr('date') || '0', 10);
		const subject = $file.attr('subject') || '';
		const name = extractFilename(subject);

		// Get groups
		const groups: string[] = [];
		$file.find('groups group').each((_, groupEl) => {
			const groupName = $(groupEl).text().trim();
			if (groupName) {
				groups.push(groupName);
				allGroups.add(groupName);
			}
		});

		// Get segments
		const segments: NzbSegment[] = [];
		let fileSize = 0;

		$file.find('segments segment').each((_, segmentEl) => {
			const $segment = $(segmentEl);
			const bytes = parseInt($segment.attr('bytes') || '0', 10);
			const number = parseInt($segment.attr('number') || '0', 10);
			const messageId = $segment.text().trim();

			if (messageId && number > 0) {
				segments.push({
					messageId,
					number,
					bytes
				});
				fileSize += bytes;
			}
		});

		// Sort segments by number
		segments.sort((a, b) => a.number - b.number);

		const fileIsRar = isRarFile(name);
		const rarPartNumber = fileIsRar ? extractRarPartNumber(name) : undefined;

		files.push({
			index,
			name,
			poster,
			date,
			subject,
			groups,
			segments,
			size: fileSize,
			isRar: fileIsRar,
			rarPartNumber
		});

		totalSize += fileSize;
	});

	// Sort files by name for consistent ordering
	files.sort((a, b) => a.name.localeCompare(b.name));

	// Re-index after sort
	files.forEach((f, i) => {
		f.index = i;
	});

	// Identify media files for streaming (only non-RAR media files now)
	const mediaFiles = files.filter((f) => isMediaFile(f.name) && !f.isRar);

	// Sort media files by size (largest first for streaming)
	mediaFiles.sort((a, b) => b.size - a.size);

	logger.debug(
		{
			hash: hash.slice(0, 12),
			fileCount: files.length,
			mediaFileCount: mediaFiles.length,
			totalSize,
			groupCount: allGroups.size
		},
		'[NzbParser] Parsed NZB'
	);

	return {
		hash,
		files,
		mediaFiles,
		totalSize,
		groups: Array.from(allGroups)
	};
}

/**
 * Check if NZB contains only RAR files (requires extraction).
 */
export function isRarOnlyNzb(parsed: ParsedNzb): boolean {
	const nonSampleFiles = parsed.files.filter(
		(f) => !f.name.toLowerCase().includes('sample') && f.size > 10 * 1024 * 1024
	);
	return nonSampleFiles.length > 0 && nonSampleFiles.every((f) => f.isRar);
}

/**
 * Get the best streamable file from parsed NZB.
 * Returns null if no streamable file found (RAR-only content).
 */
export function getBestStreamableFile(parsed: ParsedNzb): NzbFile | null {
	// Filter out sample files and small files
	const candidates = parsed.mediaFiles.filter(
		(f) => !f.name.toLowerCase().includes('sample') && f.size > 10 * 1024 * 1024
	);

	if (candidates.length === 0) {
		return null;
	}

	// Return largest file
	return candidates[0];
}
