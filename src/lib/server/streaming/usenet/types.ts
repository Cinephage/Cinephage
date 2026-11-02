/**
 * Usenet Streaming Type Definitions
 *
 * Core types for the usenet streaming subsystem.
 */

import type { Readable } from 'node:stream';
import { VIDEO_EXTENSIONS_SET, isVideoFile as isBaseVideoFile } from '#lib/config/constants.js';

/**
 * NNTP server configuration.
 */
export interface NntpServerConfig {
	id: string;
	host: string;
	port: number;
	useSsl: boolean;
	username?: string;
	password?: string;
	maxConnections: number;
	priority: number;
}

/**
 * NNTP connection state machine states.
 */
export type NntpConnectionState =
	'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'busy' | 'error';

/**
 * NNTP response codes.
 */
export const NntpResponseCode = {
	// Success codes
	POSTING_ALLOWED: 200,
	POSTING_PROHIBITED: 201,
	GROUP_SELECTED: 211,
	ARTICLE_RETRIEVED: 220,
	HEAD_FOLLOWS: 221,
	BODY_FOLLOWS: 222,
	ARTICLE_SELECTED: 223,
	// AUTH codes
	AUTH_ACCEPTED: 281,
	PASSWORD_REQUIRED: 381,
	// Error codes
	SERVICE_UNAVAILABLE: 400,
	NO_SUCH_GROUP: 411,
	ARTICLE_NOT_FOUND: 420,
	NO_SUCH_ARTICLE: 430,
	AUTH_REQUIRED: 480,
	AUTH_REJECTED: 482
} as const;

/**
 * Parsed NNTP response.
 */
export interface NntpResponse {
	code: number;
	message: string;
	data?: Buffer;
}

/**
 * yEnc header info.
 */
export interface YencHeader {
	name: string;
	line: number;
	size: number;
	part?: number;
	total?: number;
	begin?: number;
	end?: number;
}

/**
 * yEnc trailer info.
 */
export interface YencTrailer {
	size: number;
	part?: number;
	crc32?: string;
	pcrc32?: string;
}

/**
 * Decoded yEnc result.
 */
export interface YencDecodeResult {
	header: YencHeader;
	trailer: YencTrailer;
	data: Buffer;
}

/**
 * NZB segment info.
 */
export interface NzbSegment {
	messageId: string;
	number: number;
	bytes: number;
}

/**
 * NZB file info.
 */
export interface NzbFile {
	index: number;
	name: string;
	poster: string;
	date: number;
	subject: string;
	groups: string[];
	segments: NzbSegment[];
	size: number;
	isRar: boolean;
	rarPartNumber?: number;
}

/**
 * Parsed NZB result.
 */
export interface ParsedNzb {
	hash: string;
	files: NzbFile[];
	mediaFiles: NzbFile[];
	totalSize: number;
	groups: string[];
}

/**
 * Byte range for HTTP Range requests.
 */
export interface ByteRange {
	start: number;
	end: number; // -1 for open-ended (bytes=X-)
}

/**
 * Provider health tracking.
 */
export interface ProviderHealth {
	consecutiveFailures: number;
	lastSuccess: Date | null;
	lastFailure: Date | null;
	averageLatencyMs: number;
	totalRequests: number;
	backoffUntil: Date | null;
}

/**
 * Segment decode info - tracks actual decoded size.
 */
export interface SegmentDecodeInfo {
	estimatedSize: number;
	actualSize: number | null;
	estimatedOffset: number;
	actualOffset: number | null;
}

/**
 * Access pattern types for adaptive prefetch.
 */
export type AccessPattern = 'sequential' | 'random' | 'idle';

/**
 * Prefetch strategy configuration.
 */
export interface PrefetchStrategy {
	windowSize: number;
	priority: 'high' | 'low' | 'background';
}

/**
 * Stream creation result.
 */
export interface CreateStreamResult {
	stream: Readable;
	contentLength: number;
	startByte: number;
	endByte: number;
	totalSize: number;
	isPartial: boolean;
	contentType: string;
}

/**
 * Error classification for retry logic.
 */
export type ErrorType = 'retryable' | 'fatal' | 'not_found';

/**
 * Classified error with retry hint.
 */
export interface ClassifiedError {
	type: ErrorType;
	message: string;
	originalError?: Error;
}

/**
 * Common video file extensions.
 */
export const VIDEO_EXTENSIONS = VIDEO_EXTENSIONS_SET;

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.ogg', '.wav', '.m4a', '.wma']);

export const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

/**
 * RAR file patterns for detection.
 */
export const RAR_PATTERNS = [/\.rar$/i, /\.r\d{2}$/i, /\.part\d+\.rar$/i, /\.\d{3}$/];

/**
 * MIME type mappings.
 */
export const CONTENT_TYPE_MAP: Record<string, string> = {
	mkv: 'video/x-matroska',
	mp4: 'video/mp4',
	avi: 'video/x-msvideo',
	mov: 'video/quicktime',
	wmv: 'video/x-ms-wmv',
	flv: 'video/x-flv',
	webm: 'video/webm',
	m4v: 'video/x-m4v',
	mpg: 'video/mpeg',
	mpeg: 'video/mpeg',
	ts: 'video/mp2t',
	m2ts: 'video/mp2t',
	vob: 'video/dvd',
	mp3: 'audio/mpeg',
	flac: 'audio/flac',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	wav: 'audio/wav',
	m4a: 'audio/x-m4a',
	wma: 'audio/x-ms-wma'
};

/**
 * Check if a filename is a media file.
 */
export function isMediaFile(filename: string): boolean {
	const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
	return MEDIA_EXTENSIONS.has(ext);
}

export function isVideoFile(filename: string): boolean {
	return isBaseVideoFile(filename);
}

/**
 * Check if a filename is a RAR archive.
 */
export function isRarFile(filename: string): boolean {
	return RAR_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Get content type from filename.
 */
export function getContentType(filename: string): string {
	const ext = filename.toLowerCase().split('.').pop() || '';
	return CONTENT_TYPE_MAP[ext] || 'application/octet-stream';
}

/**
 * Parse HTTP Range header.
 */
export function parseRangeHeader(header: string | null, totalSize: number): ByteRange | null {
	if (!header) return null;

	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null;

	const [, startStr, endStr] = match;

	if (startStr === '' && endStr === '') return null;

	if (startStr === '') {
		const suffix = parseInt(endStr, 10);
		if (isNaN(suffix) || suffix <= 0) return null;
		return {
			start: Math.max(0, totalSize - suffix),
			end: totalSize - 1
		};
	}

	const start = parseInt(startStr, 10);
	if (isNaN(start) || start < 0 || start >= totalSize) return null;

	if (endStr === '') {
		return { start, end: -1 };
	}

	const end = parseInt(endStr, 10);
	if (isNaN(end) || end < start) return null;

	return {
		start,
		end: Math.min(end, totalSize - 1)
	};
}
