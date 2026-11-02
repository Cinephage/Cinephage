import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import type { ParsedRelease } from '#lib/server/indexers/parser/types.js';

export interface ParsedReleaseCandidate {
	label: 'sceneName' | 'currentFilename';
	value: string;
	parsed: ParsedRelease;
	score: number;
}

const parser = new ReleaseParser();

function hasMeaningfulVideoMetadata(parsed: ParsedRelease): number {
	let score = 0;
	if (parsed.resolution !== 'unknown') score += 2;
	if (parsed.source !== 'unknown') score += 2;
	if (parsed.codec !== 'unknown') score += 2;
	if (parsed.hdr) score += 1;
	if (parsed.releaseGroup) score += 1;
	if (parsed.audioCodec && parsed.audioCodec !== 'unknown') score += 1;
	if (parsed.audioChannels && parsed.audioChannels !== 'unknown') score += 1;
	if (parsed.edition) score += 2;
	if (parsed.isProper) score += 1;
	if (parsed.isRepack) score += 1;
	return score;
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function titleMatches(parsedTitle: string, actualTitle: string): boolean {
	const parsed = normalizeText(parsedTitle);
	const actual = normalizeText(actualTitle);
	if (!parsed || !actual) return false;
	return parsed === actual || actual.includes(parsed) || parsed.includes(actual);
}

export function chooseBestParsedRelease(options: {
	sceneName?: string | null;
	currentFileName: string;
	actualTitle: string;
	actualYear?: number;
}): ParsedReleaseCandidate {
	const candidates: ParsedReleaseCandidate[] = [];

	if (options.sceneName?.trim()) {
		const parsed = parser.parse(options.sceneName);
		let score = hasMeaningfulVideoMetadata(parsed) + parsed.confidence * 4;
		if (titleMatches(parsed.cleanTitle, options.actualTitle)) score += 3;
		if (options.actualYear && parsed.year === options.actualYear) score += 2;
		else if (options.actualYear && parsed.year && parsed.year !== options.actualYear) score -= 4;

		candidates.push({
			label: 'sceneName',
			value: options.sceneName,
			parsed,
			score
		});
	}

	const parsedFilename = parser.parse(options.currentFileName);
	let filenameScore = hasMeaningfulVideoMetadata(parsedFilename) + parsedFilename.confidence * 4;
	if (titleMatches(parsedFilename.cleanTitle, options.actualTitle)) filenameScore += 3;
	if (options.actualYear && parsedFilename.year === options.actualYear) filenameScore += 2;
	else if (options.actualYear && parsedFilename.year && parsedFilename.year !== options.actualYear)
		filenameScore -= 4;

	candidates.push({
		label: 'currentFilename',
		value: options.currentFileName,
		parsed: parsedFilename,
		score: filenameScore
	});

	candidates.sort((a, b) => b.score - a.score);
	return candidates[0];
}

/**
 * Resolve {AudioLanguages} for renames and imports from real audio evidence
 * only: ffprobe/mediaInfo scan data. Languages parsed from release names or
 * filenames are NOT proof of the file's audio languages, so they are never
 * used here. When the scan found no languages, returns undefined — the
 * {AudioLanguages} token then renders `und` (or omits the token entirely
 * under the includeMediaInfo config gate).
 */
export function resolveAudioLanguages(
	mediaInfoLanguages: string[] | null | undefined
): string[] | undefined {
	return mediaInfoLanguages && mediaInfoLanguages.length > 0 ? mediaInfoLanguages : undefined;
}
