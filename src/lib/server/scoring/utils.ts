import type { ReleaseAttributes } from './types.js';
import { parseRelease } from './scorer.js';
import type { HdrFormat } from '../indexers/parser/types.js';
import { isHdrFormat, sortHdrFormats } from '../indexers/parser/types.js';

export interface StoredQuality {
	resolution?: string;
	source?: string;
	codec?: string;
	/** Best HDR format, retained for rows written before `hdrFormats`. */
	hdr?: string;
	/** Every detected HDR format, best-first. */
	hdrFormats?: string[];
}

export interface ExistingFileRecord {
	sceneName?: string | null;
	relativePath: string;
	quality?: StoredQuality | null;
	releaseGroup?: string | null;
}

export function buildExistingAttrs(
	existingFile: ExistingFileRecord
): ReleaseAttributes | undefined {
	const quality = existingFile.quality;
	const sceneName = existingFile.sceneName || existingFile.relativePath;

	const UNKNOWN_VALUES = new Set(['unknown', 'undefined', '']);

	const hasStoredQuality =
		quality &&
		((quality.resolution && !UNKNOWN_VALUES.has(quality.resolution)) ||
			(quality.source && !UNKNOWN_VALUES.has(quality.source)) ||
			(quality.codec && !UNKNOWN_VALUES.has(quality.codec)) ||
			(quality.hdrFormats && quality.hdrFormats.length > 0) ||
			(quality.hdr && !UNKNOWN_VALUES.has(quality.hdr)));

	if (!hasStoredQuality) {
		return undefined;
	}

	const attrs = parseRelease(sceneName);

	if (quality.resolution && !UNKNOWN_VALUES.has(quality.resolution)) {
		attrs.resolution = quality.resolution as ReleaseAttributes['resolution'];
	}
	if (quality.source && !UNKNOWN_VALUES.has(quality.source)) {
		attrs.source = quality.source as ReleaseAttributes['source'];
	}
	if (quality.codec && !UNKNOWN_VALUES.has(quality.codec)) {
		attrs.codec = quality.codec as ReleaseAttributes['codec'];
	}

	// Prefer the stored set. Rows written before hdrFormats existed only carry
	// the scalar, which is still better evidence than re-parsing a filename.
	const storedFormats = [
		...(quality.hdrFormats ?? []),
		...(quality.hdr ? [quality.hdr] : [])
	].filter((format): format is HdrFormat => isHdrFormat(format));
	const hdrFormats = storedFormats.length > 0 ? sortHdrFormats(storedFormats) : attrs.hdrFormats;

	if (hdrFormats.length > 0) {
		attrs.hdrFormats = hdrFormats;
		attrs.hdr = hdrFormats[0];
	}

	if (existingFile.releaseGroup && existingFile.releaseGroup !== 'Streaming') {
		attrs.releaseGroup = existingFile.releaseGroup;
	}

	return attrs;
}
