/**
 * Subtitle Encoding Detection and Normalization
 *
 * Based on Bazarr's encoding handling with chardet integration.
 */

/**
 * Common encoding mappings
 */
const ENCODING_ALIASES: Record<string, string> = {
	// Windows codepages
	'windows-1250': 'cp1250',
	'windows-1251': 'cp1251',
	'windows-1252': 'cp1252',
	'windows-1253': 'cp1253',
	'windows-1254': 'cp1254',
	'windows-1255': 'cp1255',
	'windows-1256': 'cp1256',
	'windows-1257': 'cp1257',
	'windows-1258': 'cp1258',
	// ISO
	'iso-8859-1': 'latin1',
	'iso-8859-2': 'latin2',
	'iso-8859-15': 'latin9',
	// UTF
	utf8: 'utf-8',
	utf16: 'utf-16',
	'utf-16le': 'utf-16le',
	'utf-16be': 'utf-16be',
	// Other
	ascii: 'ascii',
	gb2312: 'gb2312',
	gbk: 'gbk',
	gb18030: 'gb18030',
	big5: 'big5',
	'euc-kr': 'euc-kr',
	'euc-jp': 'euc-jp',
	shift_jis: 'shift-jis',
	'koi8-r': 'koi8-r'
};

/**
 * BOM (Byte Order Mark) signatures
 */
const BOM_SIGNATURES: Array<{ bom: number[]; encoding: string }> = [
	{ bom: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
	{ bom: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
	{ bom: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
	{ bom: [0xff, 0xfe], encoding: 'utf-16le' },
	{ bom: [0xfe, 0xff], encoding: 'utf-16be' }
];

/**
 * Detect BOM in buffer
 */
export function detectBom(buffer: Buffer): { encoding: string; offset: number } | undefined {
	for (const { bom, encoding } of BOM_SIGNATURES) {
		if (buffer.length >= bom.length) {
			let match = true;
			for (let i = 0; i < bom.length; i++) {
				if (buffer[i] !== bom[i]) {
					match = false;
					break;
				}
			}
			if (match) {
				return { encoding, offset: bom.length };
			}
		}
	}
	return undefined;
}

/**
 * Simple encoding detection heuristics
 *
 * This is a simplified version - for production, use chardet npm package
 */
export function guessEncoding(buffer: Buffer): EncodingDetectionResult {
	// Check for BOM first
	const bom = detectBom(buffer);
	if (bom) {
		return {
			encoding: bom.encoding,
			confidence: 1.0,
			bomDetected: true
		};
	}

	// Count byte frequencies for heuristics
	const byteFreq = new Uint32Array(256);
	for (let i = 0; i < Math.min(buffer.length, 4096); i++) {
		byteFreq[buffer[i]]++;
	}

	// Check for UTF-8 patterns
	if (isLikelyUtf8(buffer)) {
		return {
			encoding: 'utf-8',
			confidence: 0.9,
			bomDetected: false
		};
	}

	// Check for high ASCII (likely Windows-1252 or similar)
	let highAsciiCount = 0;
	let controlCount = 0;
	for (let i = 0; i < 256; i++) {
		if (i >= 128) highAsciiCount += byteFreq[i];
		if (i < 32 && i !== 9 && i !== 10 && i !== 13) controlCount += byteFreq[i];
	}

	// Likely binary or corrupt if too many control characters
	if (controlCount > buffer.length * 0.05) {
		return {
			encoding: 'utf-8',
			confidence: 0.3,
			bomDetected: false
		};
	}

	// If no high ASCII, likely ASCII/UTF-8
	if (highAsciiCount === 0) {
		return {
			encoding: 'utf-8',
			confidence: 0.95,
			bomDetected: false
		};
	}

	// High ASCII present, likely Windows-1252 (common for subtitles)
	return {
		encoding: 'cp1252',
		confidence: 0.7,
		bomDetected: false
	};
}

/**
 * Check if buffer is likely valid UTF-8
 */
function isLikelyUtf8(buffer: Buffer): boolean {
	let i = 0;
	let validMultibyte = 0;
	let invalidSequences = 0;

	while (i < buffer.length) {
		const byte = buffer[i];

		if (byte < 0x80) {
			// ASCII
			i++;
		} else if ((byte & 0xe0) === 0xc0) {
			// 2-byte sequence
			if (i + 1 < buffer.length && (buffer[i + 1] & 0xc0) === 0x80) {
				validMultibyte++;
				i += 2;
			} else {
				invalidSequences++;
				i++;
			}
		} else if ((byte & 0xf0) === 0xe0) {
			// 3-byte sequence
			if (
				i + 2 < buffer.length &&
				(buffer[i + 1] & 0xc0) === 0x80 &&
				(buffer[i + 2] & 0xc0) === 0x80
			) {
				validMultibyte++;
				i += 3;
			} else {
				invalidSequences++;
				i++;
			}
		} else if ((byte & 0xf8) === 0xf0) {
			// 4-byte sequence
			if (
				i + 3 < buffer.length &&
				(buffer[i + 1] & 0xc0) === 0x80 &&
				(buffer[i + 2] & 0xc0) === 0x80 &&
				(buffer[i + 3] & 0xc0) === 0x80
			) {
				validMultibyte++;
				i += 4;
			} else {
				invalidSequences++;
				i++;
			}
		} else {
			// Invalid UTF-8 start byte
			invalidSequences++;
			i++;
		}
	}

	// If we have valid multibyte and few/no invalid, likely UTF-8
	return validMultibyte > 0 && invalidSequences < validMultibyte * 0.1;
}

/**
 * Encoding detection result
 */
export interface EncodingDetectionResult {
	encoding: string;
	confidence: number;
	bomDetected: boolean;
}

/**
 * Normalize encoding name
 */
export function normalizeEncodingName(encoding: string): string {
	const lower = encoding.toLowerCase().replace(/[_-]/g, '');
	return ENCODING_ALIASES[lower] ?? encoding.toLowerCase();
}

/**
 * Convert buffer to UTF-8 string
 */
export function decodeToUtf8(buffer: Buffer, encoding?: string): string {
	// Detect encoding if not provided
	if (!encoding) {
		const detected = guessEncoding(buffer);
		encoding = detected.encoding;
	}

	// Handle BOM
	const bom = detectBom(buffer);
	if (bom) {
		buffer = buffer.subarray(bom.offset);
		encoding = bom.encoding;
	}

	try {
		const decoder = new TextDecoder(encoding, { fatal: false });
		return decoder.decode(buffer);
	} catch {
		// Fallback to UTF-8
		return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
	}
}

/**
 * Encode string to buffer with specified encoding
 */
export function encodeFromUtf8(text: string, encoding = 'utf-8'): Buffer {
	const encoder = new TextEncoder();

	if (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'utf8') {
		return Buffer.from(encoder.encode(text));
	}

	// For other encodings, we need to use iconv or similar
	// For now, return UTF-8
	return Buffer.from(encoder.encode(text));
}

/**
 * Strip BOM from buffer
 */
export function stripBom(buffer: Buffer): Buffer {
	const bom = detectBom(buffer);
	if (bom) {
		return buffer.subarray(bom.offset);
	}
	return buffer;
}

/**
 * Add UTF-8 BOM to buffer
 */
export function addUtf8Bom(buffer: Buffer): Buffer {
	const bom = Buffer.from([0xef, 0xbb, 0xbf]);
	return Buffer.concat([bom, buffer]);
}

/**
 * Normalize subtitle content encoding to UTF-8
 */
export function normalizeEncoding(buffer: Buffer): NormalizedContent {
	const detection = guessEncoding(buffer);
	const text = decodeToUtf8(buffer, detection.encoding);

	// Re-encode as UTF-8
	const utf8Buffer = Buffer.from(text, 'utf-8');

	return {
		content: utf8Buffer,
		text,
		originalEncoding: detection.encoding,
		confidence: detection.confidence,
		wasConverted: detection.encoding.toLowerCase() !== 'utf-8'
	};
}

/**
 * Normalized content result
 */
export interface NormalizedContent {
	content: Buffer;
	text: string;
	originalEncoding: string;
	confidence: number;
	wasConverted: boolean;
}

/**
 * Fix common encoding issues in subtitles
 */
export function fixEncodingIssues(text: string): string {
	// Fix common mojibake patterns
	const fixes: Array<[RegExp, string]> = [
		// UTF-8 interpreted as Latin-1
		[/Ã¡/g, 'á'],
		[/Ã©/g, 'é'],
		[/Ã­/g, 'í'],
		[/Ã³/g, 'ó'],
		[/Ãº/g, 'ú'],
		[/Ã±/g, 'ñ'],
		[/Ã¼/g, 'ü'],
		[/Ã¶/g, 'ö'],
		[/Ã¤/g, 'ä'],
		[/Ã§/g, 'ç'],
		[/Ã /g, 'à'],
		[/Ã¨/g, 'è'],
		[/Ã¬/g, 'ì'],
		[/Ã²/g, 'ò'],
		[/Ã¹/g, 'ù'],
		// Smart quotes and other Windows-1252 issues
		[/â€œ/g, '"'],
		[/â€/g, '"'],
		[/â€˜/g, "'"],
		[/â€™/g, "'"],
		[/â€"/g, '-'],
		[/â€"/g, '–'],
		[/â€¦/g, '…'],
		[/Â /g, ' '],
		[/Â·/g, '·']
	];

	let fixed = text;
	for (const [pattern, replacement] of fixes) {
		fixed = fixed.replace(pattern, replacement);
	}

	return fixed;
}
