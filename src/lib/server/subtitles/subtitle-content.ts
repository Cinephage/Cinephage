/**
 * Content-based subtitle format detection and ZIP entry selection.
 *
 * The format a provider *claims* (or derives from a filename) is not trusted:
 * downloads are sniffed from their bytes so a mislabelled sidecar never gets an
 * extension that contradicts its content. ZIP archives commonly bundle several
 * languages/releases; selection here is deterministic and documented instead of
 * "first entry with a subtitle extension".
 */

import { basename, extname } from 'node:path';
import { canonicalizeLanguageTag, normalizeLanguageCode } from '#lib/shared/languages.js';
import type { SubtitleFormat } from './types';

/** File extensions treated as subtitle payloads. */
export const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.sub', '.vtt'] as const;

const SUBTITLE_EXTENSION_SET: ReadonlySet<string> = new Set(SUBTITLE_EXTENSIONS);

/**
 * ZIP local-file-header magic bytes. A provider may return a raw `.zip` with
 * an HTML/JSON error body prefixed, but genuine archives start with `PK`.
 */
export function isZipContent(content: Buffer): boolean {
	return content.length >= 2 && content[0] === 0x50 && content[1] === 0x4b;
}

/** True when `ext` (with or without dot, any case) is a subtitle extension. */
export function isSubtitleExtension(ext: string): boolean {
	const normalized = ext.toLowerCase();
	return SUBTITLE_EXTENSION_SET.has(normalized.startsWith('.') ? normalized : `.${normalized}`);
}

// A generous SRT/VTT timestamp line (`,` or `.` as the millisecond separator).
const TIMESTAMP_RE =
	/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;

// MicroDVD / .sub cue index: `{123}{456}Text`
const SUB_CUE_RE = /\{\d+\}\{\d+\}/;

/**
 * Sniff the real subtitle format from raw bytes.
 *
 * Rules, in order:
 * 1. UTF-8/UTF-16 BOM is stripped before matching.
 * 2. `WEBVTT` header -> `vtt`.
 * 3. `[Script Info]` / `[Events]` -> `ass`, unless `ScriptType: v4.00` (no `+`)
 *    marks it as the older `ssa`.
 * 4. MicroDVD `{n}{n}` cue indices -> `sub`.
 * 5. Any `HH:MM:SS,mmm --> HH:MM:SS,mmm` timestamp -> `srt`.
 * 6. Remaining `-->` timing arrows -> `vtt` (header-less VTT).
 * 7. Anything else -> `unknown` (callers must not invent an extension).
 */
export function detectSubtitleFormatFromContent(content: Buffer): SubtitleFormat {
	if (isZipContent(content)) return 'unknown';

	const text = decodeTextHead(content);
	if (!text) return 'unknown';

	const trimmed = text.trimStart();
	if (/^WEBVTT(\s|$)/i.test(trimmed)) return 'vtt';

	if (/\[Script Info\]/i.test(trimmed) || /\[Events\]/i.test(trimmed)) {
		if (/ScriptType:\s*v4\.00\+/i.test(trimmed)) return 'ass';
		if (/ScriptType:\s*v4\.00/i.test(trimmed)) return 'ssa';
		return 'ass';
	}

	if (SUB_CUE_RE.test(trimmed)) return 'sub';
	if (TIMESTAMP_RE.test(trimmed)) return 'srt';
	if (/-->/.test(trimmed)) return 'vtt';

	return 'unknown';
}

/**
 * Decode the head of a buffer as text, stripping a UTF-8/UTF-16 BOM. Returns an
 * empty string for content that is clearly binary (NUL byte before any text).
 */
function decodeTextHead(content: Buffer): string {
	const head = content.subarray(0, 64 * 1024);

	if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
		return head.subarray(2).toString('utf16le');
	}
	if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
		// Rare UTF-16BE; swap bytes so Node's utf16le decoder can read it.
		const swapped = Buffer.from(head.subarray(2));
		swapped.swap16();
		return swapped.toString('utf16le');
	}

	const bomStripped =
		head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
			? head.subarray(3)
			: head;

	// A NUL byte before any printable character indicates binary (e.g. VobSub).
	const nulIndex = bomStripped.indexOf(0);
	if (nulIndex !== -1 && nulIndex < 32) return '';

	return bomStripped.toString('utf-8');
}

/** Minimal shape of a ZIP entry needed for selection (AdmZip-compatible). */
export interface ZipEntryLike {
	entryName: string;
	isDirectory: boolean;
	getData(): Buffer;
}

/** What the download is trying to fetch, used to disambiguate archive entries. */
export interface ZipSelectionTarget {
	/** Canonical/normalized target language tag. */
	language: string;
	isForced?: boolean;
	isHearingImpaired?: boolean;
	/** Target video file name (episode release); used for episode/release matching. */
	videoFileName?: string | null;
	/** Provider release name, when known. */
	releaseName?: string | null;
	/** Provider-claimed subtitle file name, when known. */
	fileName?: string | null;
}

export interface ZipSelectionResult {
	entry: ZipEntryLike;
	/** Candidate entry names in deterministic order (for logging). */
	candidates: string[];
	/** True when more than one candidate shared the winning rank. */
	ambiguous: boolean;
}

/**
 * Choose the subtitle entry from a ZIP archive.
 *
 * Documented order:
 * 1. Single candidate with a subtitle extension -> use it.
 * 2. Rank every candidate: exact language-tag match (weight 8) > preferred
 *    episode/release match (4) > forced-tag match when forced was requested (2)
 *    > HI-tag match when HI was requested (1).
 * 3. Unique highest rank wins.
 * 4. Ties are broken by entry name (`localeCompare`) so the choice is
 *    deterministic; the caller is told it was ambiguous and should log it.
 *
 * Throws when the archive contains no subtitle-extension entry at all.
 */
export function selectSubtitleZipEntry(
	entries: ZipEntryLike[],
	target: ZipSelectionTarget
): ZipSelectionResult {
	const candidates = entries.filter(
		(entry) => !entry.isDirectory && isSubtitleExtension(extname(entry.entryName))
	);

	if (candidates.length === 0) {
		throw new Error('No subtitle file found in zip archive');
	}

	const sorted = [...candidates].sort((a, b) => a.entryName.localeCompare(b.entryName));
	const candidateNames = sorted.map((entry) => entry.entryName);

	if (sorted.length === 1) {
		return { entry: sorted[0], candidates: candidateNames, ambiguous: false };
	}

	const targetLanguage = normalizeZipLanguage(target.language);
	const targetStem = stemKey(target.videoFileName ?? target.releaseName ?? target.fileName);

	const ranked = sorted.map((entry) => ({
		entry,
		rank: rankEntry(entry.entryName, target, targetLanguage, targetStem)
	}));
	const bestRank = Math.max(...ranked.map((item) => item.rank));
	const winners = ranked.filter((item) => item.rank === bestRank);

	return {
		entry: winners[0].entry,
		candidates: candidateNames,
		ambiguous: winners.length > 1
	};
}

/** Normalize a target language for token comparison ('' when unusable). */
function normalizeZipLanguage(language: string): string {
	const normalized = normalizeLanguageCode(language);
	if (normalized && normalized !== 'und') return normalized;
	return canonicalizeLanguageTag(language);
}

/** Split a file name into lower-case alphanumeric tokens. */
function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** True when the entry name carries a token canonicalizing to `targetLanguage`. */
function hasLanguageToken(entryName: string, targetLanguage: string): boolean {
	if (!targetLanguage) return false;
	const entryTokens = tokens(entryName);
	for (const token of entryTokens) {
		const canonical = canonicalizeLanguageTag(token) || normalizeLanguageCode(token);
		if (canonical && canonical.toLowerCase() === targetLanguage.toLowerCase()) return true;
	}
	// Region variants can span two tokens (`pt-BR` -> `pt` + `br`).
	for (let i = 0; i < entryTokens.length - 1; i++) {
		const combined = `${entryTokens[i]}-${entryTokens[i + 1]}`;
		const canonical = canonicalizeLanguageTag(combined);
		if (canonical && canonical.toLowerCase() === targetLanguage.toLowerCase()) return true;
	}
	return false;
}

function hasFlagToken(entryName: string, flags: string[]): boolean {
	const entryTokens = tokens(entryName);
	return flags.some((flag) => entryTokens.includes(flag));
}

/** Separator-insensitive key used for release/episode stem comparison. */
function stemKey(value: string | null | undefined): string {
	if (!value) return '';
	const base = basename(value, extname(value));
	return base.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Release key for an archive entry: strips the trailing language/flag suffix
 * chain (`.en`, `.en.hi`, `.forced`, ...) before comparison so
 * `Show.S01E02.en.srt` matches the video stem `Show.S01E02`.
 */
function entryStemKey(entryName: string): string {
	let base = basename(entryName, extname(entryName));
	base = base.replace(/(\.[a-z]{2,3}(?:-[a-z]{2,4})?)+$/i, '');
	base = base.replace(/\.(forced|force|hi|sdh|cc|default)$/i, '');
	return base.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isReleaseMatch(entryName: string, targetStem: string): boolean {
	if (!targetStem) return false;
	const entryKey = entryStemKey(entryName);
	if (!entryKey) return false;
	if (entryKey === targetStem) return true;
	if (targetStem.length >= 8 && entryKey.includes(targetStem)) return true;
	if (entryKey.length >= 8 && targetStem.includes(entryKey)) return true;
	return false;
}

function rankEntry(
	entryName: string,
	target: ZipSelectionTarget,
	targetLanguage: string,
	targetStem: string
): number {
	let rank = 0;
	if (hasLanguageToken(entryName, targetLanguage)) rank += 8;
	if (isReleaseMatch(entryName, targetStem)) rank += 4;
	if (target.isForced && hasFlagToken(entryName, ['forced', 'force'])) rank += 2;
	if (target.isHearingImpaired && hasFlagToken(entryName, ['hi', 'sdh', 'cc', 'hearingimpaired']))
		rank += 1;
	return rank;
}
