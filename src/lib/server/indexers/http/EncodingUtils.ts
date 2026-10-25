/**
 * Centralized Encoding Utilities for Indexers
 *
 * Handles encoding conversion for non-UTF-8 indexers (RuTracker, etc.)
 * Single source of truth used by IndexerHttp, AuthManager, and cloudflare-fetch
 */

import iconv from 'iconv-lite';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'EncodingUtils', logDomain: 'indexers' });

// Encoding name normalization mapping
const ENCODING_ALIASES: Record<string, string> = {
	// Windows codepages
	'windows-1251': 'windows-1251',
	win1251: 'windows-1251',
	cp1251: 'windows-1251',
	'windows-1252': 'windows-1252',
	win1252: 'windows-1252',
	cp1252: 'windows-1252',
	'windows-1250': 'windows-1250',
	win1250: 'windows-1250',
	cp1250: 'windows-1250',
	// ISO
	'iso-8859-1': 'iso-8859-1',
	'iso-8859-2': 'iso-8859-2',
	latin1: 'iso-8859-1',
	latin2: 'iso-8859-2',
	// UTF
	utf8: 'utf-8',
	'utf-8': 'utf-8'
};

// BOM signatures for detection
const BOM_SIGNATURES = [
	{ bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
	{ bytes: [0xff, 0xfe], encoding: 'utf-16le' },
	{ bytes: [0xfe, 0xff], encoding: 'utf-16be' }
];

/**
 * Normalize encoding name to standard form
 */
export function normalizeEncoding(encoding: string | undefined): string {
	if (!encoding) return 'utf-8';
	const normalized = encoding.toLowerCase().replace(/[_\s-]/g, '');
	return ENCODING_ALIASES[normalized] || encoding.toLowerCase();
}

/**
 * Detect encoding from BOM (Byte Order Mark)
 */
export function detectBomEncoding(buffer: Buffer): string | undefined {
	for (const { bytes, encoding } of BOM_SIGNATURES) {
		if (buffer.length >= bytes.length) {
			let match = true;
			for (let i = 0; i < bytes.length; i++) {
				if (buffer[i] !== bytes[i]) {
					match = false;
					break;
				}
			}
			if (match) return encoding;
		}
	}
	return undefined;
}

/**
 * Decode buffer to string with proper encoding handling
 * Priority: 1) Explicit encoding, 2) BOM detection, 3) UTF-8 fallback
 */
export function decodeBuffer(
	buffer: Buffer,
	explicitEncoding?: string
): { text: string; encoding: string; bomDetected: boolean } {
	// Priority 1: Check for BOM
	const bomEncoding = detectBomEncoding(buffer);
	if (bomEncoding) {
		return {
			text: iconv.decode(buffer, bomEncoding),
			encoding: bomEncoding,
			bomDetected: true
		};
	}

	// Priority 2: Use explicit encoding if specified and not UTF-8
	const normalizedEncoding = normalizeEncoding(explicitEncoding);
	if (normalizedEncoding && normalizedEncoding !== 'utf-8') {
		try {
			return {
				text: iconv.decode(buffer, normalizedEncoding),
				encoding: normalizedEncoding,
				bomDetected: false
			};
		} catch {
			// Fall through to UTF-8 if decoding fails
			logger.warn(`Failed to decode with ${normalizedEncoding}, falling back to UTF-8`);
		}
	}

	// Priority 3: UTF-8 fallback
	return {
		text: iconv.decode(buffer, 'utf-8'),
		encoding: 'utf-8',
		bomDetected: false
	};
}

/**
 * Encode string to buffer with specified encoding
 */
export function encodeString(text: string, encoding: string): Buffer {
	const normalizedEncoding = normalizeEncoding(encoding);
	if (normalizedEncoding === 'utf-8') {
		return Buffer.from(text, 'utf-8');
	}
	return iconv.encode(text, normalizedEncoding);
}

/**
 * URL-encode a string using the specified character encoding.
 * For UTF-8, uses standard encodeURIComponent.
 * For other encodings (e.g., windows-1251), converts to bytes first, then URL-encodes each byte.
 *
 * Example with "тест" (Russian for "test"):
 * - UTF-8: %D1%82%D0%B5%D1%81%D1%82
 * - windows-1251: %F2%E5%F1%F2
 */
export function encodeUrlParam(text: string, encoding: string): string {
	const normalizedEncoding = normalizeEncoding(encoding);

	// For UTF-8, use standard encodeURIComponent
	if (normalizedEncoding === 'utf-8') {
		return encodeURIComponent(text);
	}

	// For non-UTF-8 encodings, encode to bytes first, then URL-encode each byte
	const buffer = encodeString(text, normalizedEncoding);
	return Array.from(buffer)
		.map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
		.join('');
}
