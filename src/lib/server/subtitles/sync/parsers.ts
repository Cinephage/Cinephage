/**
 * Subtitle Format Parsers
 *
 * Extracts TimeSpan arrays from SRT, ASS/SSA, and VTT subtitle files.
 * These TimeSpans represent when each subtitle cue is displayed, which
 * is the input the alignment algorithm needs.
 *
 * Also provides functions to apply per-cue deltas back to the original
 * subtitle content (rewriting timestamps without altering text).
 */

import type { TimeSpan, TimeDelta } from './types.js';
import type { SubtitleFormat } from '../types.js';

/**
 * A parsed cue with its original timing and text content.
 * Used for applying deltas back to the subtitle file.
 */
export interface ParsedCue {
	/** Index in the original file (for SRT: sequence number) */
	index: number;
	/** Start time in milliseconds */
	startTime: number;
	/** End time in milliseconds */
	endTime: number;
	/** Raw text content of this cue */
	text: string;
	/** For ASS/SSA: the full original line (for faithful reconstruction) */
	rawLine?: string;
}

// =============================================================================
// SRT Parsing
// =============================================================================

const SRT_TIMESTAMP_RE =
	/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;

/**
 * Parse a timestamp component to milliseconds.
 */
function srtTimeToMs(hours: string, minutes: string, seconds: string, ms: string): number {
	return (
		parseInt(hours) * 3600000 + parseInt(minutes) * 60000 + parseInt(seconds) * 1000 + parseInt(ms)
	);
}

/**
 * Format milliseconds to SRT timestamp: HH:MM:SS,mmm
 */
export function msToSrtTime(ms: number): string {
	ms = Math.max(0, Math.round(ms));
	const hours = Math.floor(ms / 3600000);
	const minutes = Math.floor((ms % 3600000) / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	const millis = ms % 1000;
	return (
		String(hours).padStart(2, '0') +
		':' +
		String(minutes).padStart(2, '0') +
		':' +
		String(seconds).padStart(2, '0') +
		',' +
		String(millis).padStart(3, '0')
	);
}

/**
 * Parse SRT content into cues.
 */
export function parseSrtCues(content: string): ParsedCue[] {
	const cues: ParsedCue[] = [];
	const blocks = content.trim().split(/\r?\n\r?\n/);

	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		if (lines.length < 3) continue;

		const index = parseInt(lines[0], 10);
		if (isNaN(index)) continue;

		const timingMatch = lines[1].match(SRT_TIMESTAMP_RE);
		if (!timingMatch) continue;

		const startTime = srtTimeToMs(timingMatch[1], timingMatch[2], timingMatch[3], timingMatch[4]);
		const endTime = srtTimeToMs(timingMatch[5], timingMatch[6], timingMatch[7], timingMatch[8]);
		const text = lines.slice(2).join('\n');

		cues.push({ index, startTime, endTime, text });
	}

	return cues;
}

/**
 * Extract TimeSpans from SRT content.
 */
export function parseSrtToSpans(content: string): TimeSpan[] {
	return parseSrtCues(content).map((cue) => ({ start: cue.startTime, end: cue.endTime }));
}

/**
 * Apply per-cue deltas to SRT content.
 */
export function applySrtDeltas(content: string, deltas: TimeDelta[]): string {
	const cues = parseSrtCues(content);
	if (cues.length !== deltas.length) {
		throw new Error(`Delta count (${deltas.length}) does not match cue count (${cues.length})`);
	}

	return cues
		.map((cue, i) => {
			const newStart = msToSrtTime(cue.startTime + deltas[i]);
			const newEnd = msToSrtTime(cue.endTime + deltas[i]);
			return `${i + 1}\n${newStart} --> ${newEnd}\n${cue.text}`;
		})
		.join('\n\n');
}

// =============================================================================
// ASS/SSA Parsing
// =============================================================================

const ASS_TIMESTAMP_RE = /(\d+):(\d{2}):(\d{2})\.(\d{2})/;

/**
 * Parse ASS/SSA timestamp to milliseconds.
 * Format: H:MM:SS.cc (centiseconds)
 */
function assTimeToMs(hours: string, minutes: string, seconds: string, centis: string): number {
	return (
		parseInt(hours) * 3600000 +
		parseInt(minutes) * 60000 +
		parseInt(seconds) * 1000 +
		parseInt(centis) * 10
	);
}

/**
 * Format milliseconds to ASS timestamp: H:MM:SS.cc
 */
export function msToAssTime(ms: number): string {
	ms = Math.max(0, Math.round(ms));
	const hours = Math.floor(ms / 3600000);
	const minutes = Math.floor((ms % 3600000) / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	const centis = Math.floor((ms % 1000) / 10);
	return (
		String(hours) +
		':' +
		String(minutes).padStart(2, '0') +
		':' +
		String(seconds).padStart(2, '0') +
		'.' +
		String(centis).padStart(2, '0')
	);
}

/**
 * Parse ASS/SSA Dialogue lines into cues.
 */
export function parseAssCues(content: string): ParsedCue[] {
	const cues: ParsedCue[] = [];
	const lines = content.split(/\r?\n/);

	let inEvents = false;
	let cueIndex = 0;

	for (const line of lines) {
		if (line.trim().startsWith('[Events]')) {
			inEvents = true;
			continue;
		}
		if (line.trim().startsWith('[') && inEvents) {
			inEvents = false;
		}
		if (!inEvents || !line.startsWith('Dialogue:')) continue;

		// Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
		// Split on comma, but Text field can contain commas
		const parts = line.substring('Dialogue:'.length).split(',');
		if (parts.length < 10) continue;

		const startMatch = parts[1].trim().match(ASS_TIMESTAMP_RE);
		const endMatch = parts[2].trim().match(ASS_TIMESTAMP_RE);
		if (!startMatch || !endMatch) continue;

		const startTime = assTimeToMs(startMatch[1], startMatch[2], startMatch[3], startMatch[4]);
		const endTime = assTimeToMs(endMatch[1], endMatch[2], endMatch[3], endMatch[4]);
		const text = parts.slice(9).join(',');

		cueIndex++;
		cues.push({ index: cueIndex, startTime, endTime, text, rawLine: line });
	}

	return cues;
}

/**
 * Extract TimeSpans from ASS/SSA content.
 */
export function parseAssToSpans(content: string): TimeSpan[] {
	return parseAssCues(content).map((cue) => ({ start: cue.startTime, end: cue.endTime }));
}

/**
 * Apply per-cue deltas to ASS/SSA content.
 * Rewrites Dialogue line timestamps while preserving everything else.
 */
export function applyAssDeltas(content: string, deltas: TimeDelta[]): string {
	const lines = content.split(/\r?\n/);
	const result: string[] = [];

	let inEvents = false;
	let dialogueIndex = 0;

	for (const line of lines) {
		if (line.trim().startsWith('[Events]')) {
			inEvents = true;
			result.push(line);
			continue;
		}
		if (line.trim().startsWith('[') && inEvents) {
			inEvents = false;
		}

		if (!inEvents || !line.startsWith('Dialogue:')) {
			result.push(line);
			continue;
		}

		// This is a Dialogue line - apply delta
		const parts = line.substring('Dialogue:'.length).split(',');
		if (parts.length < 10 || dialogueIndex >= deltas.length) {
			result.push(line);
			dialogueIndex++;
			continue;
		}

		const startMatch = parts[1].trim().match(ASS_TIMESTAMP_RE);
		const endMatch = parts[2].trim().match(ASS_TIMESTAMP_RE);
		if (!startMatch || !endMatch) {
			result.push(line);
			dialogueIndex++;
			continue;
		}

		const startMs = assTimeToMs(startMatch[1], startMatch[2], startMatch[3], startMatch[4]);
		const endMs = assTimeToMs(endMatch[1], endMatch[2], endMatch[3], endMatch[4]);
		const delta = deltas[dialogueIndex];

		parts[1] = msToAssTime(startMs + delta);
		parts[2] = msToAssTime(endMs + delta);

		result.push('Dialogue:' + parts.join(','));
		dialogueIndex++;
	}

	return result.join('\n');
}

// =============================================================================
// VTT Parsing
// =============================================================================

const VTT_TIMESTAMP_RE =
	/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

const VTT_TIMESTAMP_SHORT_RE = /(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2})\.(\d{3})/;

/**
 * Format milliseconds to VTT timestamp: HH:MM:SS.mmm
 */
export function msToVttTime(ms: number): string {
	ms = Math.max(0, Math.round(ms));
	const hours = Math.floor(ms / 3600000);
	const minutes = Math.floor((ms % 3600000) / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	const millis = ms % 1000;
	return (
		String(hours).padStart(2, '0') +
		':' +
		String(minutes).padStart(2, '0') +
		':' +
		String(seconds).padStart(2, '0') +
		'.' +
		String(millis).padStart(3, '0')
	);
}

/**
 * Parse VTT content into cues.
 */
export function parseVttCues(content: string): ParsedCue[] {
	const cues: ParsedCue[] = [];
	// Remove WEBVTT header and any style/region blocks
	const blocks = content.trim().split(/\r?\n\r?\n/);
	let cueIndex = 0;

	for (const block of blocks) {
		const lines = block.split(/\r?\n/);

		// Find the timing line
		let timingLineIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes('-->')) {
				timingLineIdx = i;
				break;
			}
		}
		if (timingLineIdx === -1) continue;

		const timingLine = lines[timingLineIdx];

		// Try full format first: HH:MM:SS.mmm
		let match = timingLine.match(VTT_TIMESTAMP_RE);
		let startTime: number;
		let endTime: number;

		if (match) {
			startTime = srtTimeToMs(match[1], match[2], match[3], match[4]);
			endTime = srtTimeToMs(match[5], match[6], match[7], match[8]);
		} else {
			// Try short format: MM:SS.mmm
			match = timingLine.match(VTT_TIMESTAMP_SHORT_RE);
			if (!match) continue;
			startTime = parseInt(match[1]) * 60000 + parseInt(match[2]) * 1000 + parseInt(match[3]);
			endTime = parseInt(match[4]) * 60000 + parseInt(match[5]) * 1000 + parseInt(match[6]);
		}

		const text = lines.slice(timingLineIdx + 1).join('\n');
		cueIndex++;
		cues.push({ index: cueIndex, startTime, endTime, text });
	}

	return cues;
}

/**
 * Extract TimeSpans from VTT content.
 */
export function parseVttToSpans(content: string): TimeSpan[] {
	return parseVttCues(content).map((cue) => ({ start: cue.startTime, end: cue.endTime }));
}

/**
 * Apply per-cue deltas to VTT content.
 */
export function applyVttDeltas(content: string, deltas: TimeDelta[]): string {
	const lines = content.split(/\r?\n/);
	const result: string[] = [];
	let deltaIndex = 0;

	for (const line of lines) {
		if (!line.includes('-->') || deltaIndex >= deltas.length) {
			result.push(line);
			continue;
		}

		const delta = deltas[deltaIndex];

		// Try full format
		let match = line.match(VTT_TIMESTAMP_RE);
		if (match) {
			const startMs = srtTimeToMs(match[1], match[2], match[3], match[4]);
			const endMs = srtTimeToMs(match[5], match[6], match[7], match[8]);
			// Preserve anything after the timestamps (position/align settings)
			const afterTimestamps = line.substring(match[0].length);
			result.push(
				msToVttTime(startMs + delta) + ' --> ' + msToVttTime(endMs + delta) + afterTimestamps
			);
			deltaIndex++;
			continue;
		}

		// Try short format
		match = line.match(VTT_TIMESTAMP_SHORT_RE);
		if (match) {
			const startMs = parseInt(match[1]) * 60000 + parseInt(match[2]) * 1000 + parseInt(match[3]);
			const endMs = parseInt(match[4]) * 60000 + parseInt(match[5]) * 1000 + parseInt(match[6]);
			const afterTimestamps = line.substring(match[0].length);
			result.push(
				msToVttTime(startMs + delta) + ' --> ' + msToVttTime(endMs + delta) + afterTimestamps
			);
			deltaIndex++;
			continue;
		}

		result.push(line);
	}

	return result.join('\n');
}

// =============================================================================
// Format Detection & Dispatch
// =============================================================================

/**
 * Detect subtitle format from content.
 */
export function detectFormat(content: string): SubtitleFormat {
	const trimmed = content.trimStart();
	if (trimmed.startsWith('WEBVTT')) return 'vtt';
	if (trimmed.includes('[Script Info]') || trimmed.includes('[Events]')) {
		// Distinguish ASS from SSA by version tag
		if (trimmed.includes('ScriptType: v4.00+')) return 'ass';
		if (trimmed.includes('ScriptType: v4.00')) return 'ssa';
		return 'ass'; // Default to ASS
	}
	if (SRT_TIMESTAMP_RE.test(content)) return 'srt';
	return 'unknown';
}

/**
 * Parse any supported subtitle format to TimeSpan array.
 */
export function parseSubtitleToSpans(content: string, format?: SubtitleFormat): TimeSpan[] {
	const fmt = format ?? detectFormat(content);
	switch (fmt) {
		case 'srt':
			return parseSrtToSpans(content);
		case 'ass':
		case 'ssa':
			return parseAssToSpans(content);
		case 'vtt':
			return parseVttToSpans(content);
		default:
			throw new Error(`Unsupported subtitle format for sync: ${fmt}`);
	}
}

/**
 * Parse any supported subtitle format to ParsedCue array.
 */
export function parseSubtitleToCues(content: string, format?: SubtitleFormat): ParsedCue[] {
	const fmt = format ?? detectFormat(content);
	switch (fmt) {
		case 'srt':
			return parseSrtCues(content);
		case 'ass':
		case 'ssa':
			return parseAssCues(content);
		case 'vtt':
			return parseVttCues(content);
		default:
			throw new Error(`Unsupported subtitle format for sync: ${fmt}`);
	}
}

/**
 * Apply per-cue deltas to any supported subtitle format.
 */
export function applyDeltas(content: string, deltas: TimeDelta[], format?: SubtitleFormat): string {
	const fmt = format ?? detectFormat(content);
	switch (fmt) {
		case 'srt':
			return applySrtDeltas(content, deltas);
		case 'ass':
		case 'ssa':
			return applyAssDeltas(content, deltas);
		case 'vtt':
			return applyVttDeltas(content, deltas);
		default:
			throw new Error(`Unsupported subtitle format for sync: ${fmt}`);
	}
}
