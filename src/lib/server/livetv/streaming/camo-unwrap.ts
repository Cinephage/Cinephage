/**
 * Camouflaged MPEG-TS segment unwrapping (DaddyLive "camo" containers)
 *
 * Some Live TV upstreams disguise their HLS video segments as innocuous files
 * (images / marker-prefixed blobs) to dodge naive blocking. Every segment body
 * is one of a small set of container formats; the real MPEG-TS payload (or a
 * gzip of it) is hidden inside. This module sniffs the container and returns
 * the raw TS bytes so the normal demux pipeline can continue.
 *
 * Container formats, in sniff order:
 *
 *  1. webp-exif    `RIFF....WEBP` — walk RIFF chunks; the `EXIF` chunk holds
 *                  raw TS (0x47 at offset 0 and +188).
 *  2. png-iend     PNG file — walk chunks; the bytes after `IEND` are raw TS.
 *  3. png-tiktipx  PNG image whose decoded 8-bit RGB/RGBA pixels (full
 *                  unfiltering incl. Paeth) start with the ASCII magic
 *                  `TIKTIKPX` (the live upstream spelling; older experiments
 *                  used the 7-byte `TIKTIPX`), followed by a u32be length and
 *                  gzip(TS). The gzip stream is located by its own magic, so
 *                  both spellings decode identically.
 *  4. tikti-raw    ASCII marker `TIKTIRAW` — raw TS after the marker.
 *  5. tikti-tsgz   ASCII marker `TIKTITSGZ` — gzip(TS) after the marker.
 *  6. ts-scan      fallback: first offset i where 0x47 sits at i and i+188.
 *
 * Plain TS (sync byte at offset 0) passes through untouched, so the sniff
 * chain is safe to apply to every segment in the Live TV pipeline regardless
 * of provider. Unknown containers throw CamoUnwrapError with the leading
 * bytes so operators can spot upstream format experiments.
 */

import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'CamoUnwrap', logDomain: 'livetv' as const });

/** Container formats recognized by the sniff chain. */
export type CamoFormat =
	'webp-exif' | 'png-iend' | 'png-tiktipx' | 'tikti-raw' | 'tikti-tsgz' | 'ts-scan' | 'plain-ts';

const TS_SYNC_BYTE = 0x47;
const TS_PACKET_BYTES = 188;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** PNG color types carrying full bytes per sample (only these are supported). */
const PNG_COLOR_TYPE_RGB = 2;
const PNG_COLOR_TYPE_RGBA = 6;

/** Raised when a segment matches no known container. */
export class CamoUnwrapError extends Error {
	/** Total size of the rejected segment body. */
	readonly byteLength: number;
	/** Hex dump of the leading bytes, for upstream format triage. */
	readonly prefixHex: string;

	constructor(message: string, byteLength: number, prefixHex: string) {
		super(message);
		this.name = 'CamoUnwrapError';
		this.byteLength = byteLength;
		this.prefixHex = prefixHex;
	}
}

export interface CamoUnwrapResult {
	/** MPEG-TS payload (a view into `input` where no copy was needed). */
	data: Uint8Array;
	/** Container format that was detected. */
	format: CamoFormat;
}

function matchesAscii(data: Uint8Array, offset: number, text: string): boolean {
	if (offset + text.length > data.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (data[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

function hasPngSignature(data: Uint8Array): boolean {
	if (data.length < PNG_SIGNATURE.length) return false;
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (data[i] !== PNG_SIGNATURE[i]) return false;
	}
	return true;
}

/**
 * True when a TS sync byte pair sits at `i`/`i+188` (and at `i+376` when that
 * offset is in range). The third check keeps the fallback scan from firing on
 * coincidental byte pairs in non-TS bodies; real segments are megabytes long,
 * so requiring it can never reject valid TS.
 */
function looksLikeTsAt(data: Uint8Array, i: number): boolean {
	if (data[i] !== TS_SYNC_BYTE) return false;
	if (i + TS_PACKET_BYTES >= data.length || data[i + TS_PACKET_BYTES] !== TS_SYNC_BYTE) {
		return false;
	}
	const thirdSync = i + TS_PACKET_BYTES * 2;
	if (thirdSync < data.length && data[thirdSync] !== TS_SYNC_BYTE) return false;
	return true;
}

function hexPrefix(data: Uint8Array, length = 16): string {
	const bytes = data.subarray(0, Math.min(length, data.length));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Walk RIFF chunks of a WEBP file and return the EXIF chunk payload. */
function findWebpExifPayload(data: Uint8Array): Uint8Array | null {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 12; // skip 'RIFF' + size + 'WEBP'
	while (offset + 8 <= data.length) {
		const fourcc = String.fromCharCode(
			data[offset],
			data[offset + 1],
			data[offset + 2],
			data[offset + 3]
		);
		const size = view.getUint32(offset + 4, true); // little-endian
		const chunkStart = offset + 8;
		if (fourcc === 'EXIF') {
			return data.subarray(chunkStart, Math.min(chunkStart + size, data.length));
		}
		// Odd-sized chunks are padded to an even boundary.
		offset = chunkStart + size + (size % 2);
	}
	return null;
}

/**
 * Walk PNG chunks and return whatever follows the mandatory IEND chunk,
 * or null when IEND is missing/last.
 */
function findPngPayloadAfterIend(data: Uint8Array): Uint8Array | null {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset: number = PNG_SIGNATURE.length;
	while (offset + 8 <= data.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(
			data[offset + 4],
			data[offset + 5],
			data[offset + 6],
			data[offset + 7]
		);
		const chunkEnd = offset + 8 + length + 4; // data + CRC
		if (type === 'IEND') {
			return chunkEnd < data.length ? data.subarray(chunkEnd) : null;
		}
		if (chunkEnd <= offset) return null; // corrupt length — stop walking
		offset = chunkEnd;
	}
	return null;
}

interface DecodedPngRaster {
	raster: Uint8Array;
}

/**
 * Decode a PNG's pixel raster in pure JS (no canvas): collect IDATs, inflate,
 * and reverse the per-row filters (None/Sub/Up/Average/Paeth). Only 8-bit
 * RGB/RGBA non-interlaced images are supported — that is all the upstream
 * experiments use.
 */
function decodePngRaster(data: Uint8Array): DecodedPngRaster | null {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let width = 0;
	let height = 0;
	let bitsPerSample = 0;
	let colorType = 0;
	let interlace = 0;
	const idatChunks: Uint8Array[] = [];
	let idatLength = 0;

	let offset: number = PNG_SIGNATURE.length;
	while (offset + 8 <= data.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(
			data[offset + 4],
			data[offset + 5],
			data[offset + 6],
			data[offset + 7]
		);
		const dataStart = offset + 8;
		if (dataStart + length > data.length) return null;

		if (type === 'IHDR') {
			width = view.getUint32(dataStart);
			height = view.getUint32(dataStart + 4);
			bitsPerSample = data[dataStart + 8];
			colorType = data[dataStart + 9];
			interlace = data[dataStart + 12];
		} else if (type === 'IDAT') {
			idatChunks.push(data.subarray(dataStart, dataStart + length));
			idatLength += length;
		} else if (type === 'IEND') {
			break;
		}
		offset = dataStart + length + 4;
	}

	const bytesPerSample =
		colorType === PNG_COLOR_TYPE_RGBA ? 4 : colorType === PNG_COLOR_TYPE_RGB ? 3 : 0;
	if (
		width <= 0 ||
		height <= 0 ||
		bitsPerSample !== 8 ||
		bytesPerSample === 0 ||
		interlace !== 0 ||
		idatChunks.length === 0
	) {
		return null;
	}

	const stride = width * bytesPerSample;
	const idat = new Uint8Array(idatLength);
	let idatOffset = 0;
	for (const chunk of idatChunks) {
		idat.set(chunk, idatOffset);
		idatOffset += chunk.byteLength;
	}

	let filtered: Uint8Array;
	try {
		// PNG IDAT holds a zlib-wrapped DEFLATE stream; node:zlib ignores any
		// trailing bytes after the stream (unlike fflate, which treats them as
		// a second concatenated member and fails).
		filtered = inflateSync(idat);
	} catch {
		return null;
	}
	if (filtered.length < height * (stride + 1)) return null;

	const raster = new Uint8Array(height * stride);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = filtered[pos++];
		const row = y * stride;
		const previousRow = row - stride;
		for (let x = 0; x < stride; x++) {
			const raw = filtered[pos + x];
			const left = x >= bytesPerSample ? raster[row + x - bytesPerSample] : 0;
			const up = y > 0 ? raster[previousRow + x] : 0;
			const upLeft = x >= bytesPerSample && y > 0 ? raster[previousRow + x - bytesPerSample] : 0;
			let value: number;
			switch (filter) {
				case 0: // None
					value = raw;
					break;
				case 1: // Sub
					value = raw + left;
					break;
				case 2: // Up
					value = raw + up;
					break;
				case 3: // Average
					value = raw + ((left + up) >> 1);
					break;
				case 4: // Paeth
					value = raw + paethPredictor(left, up, upLeft);
					break;
				default:
					return null;
			}
			raster[row + x] = value & 0xff;
		}
		pos += stride;
	}

	return { raster };
}

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * Decompress a gzip stream that may carry headers node zlib's strict gzip
 * validation rejects (the upstream minted streams with non-standard XFL/OS
 * bytes that fail "incorrect header check"). Falls back to parsing the header
 * length from the FLG flags and raw-inflating the deflate stream directly.
 */
function gunzipTolerant(data: Uint8Array): Uint8Array {
	try {
		return gunzipSync(data);
	} catch {
		// Parse the variable-length gzip header (RFC 1952) and raw-inflate.
		if (data.byteLength < 10 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 0x08) {
			throw new Error('not a gzip stream');
		}
		const flg = data[3];
		let headerLength = 10;
		if (flg & 0b100) {
			// FEXTRA: 2-byte LE length + that many bytes
			headerLength += 2 + (data[10] | (data[11] << 8));
		}
		if (flg & 0b1000) {
			// FNAME: zero-terminated string
			let i = headerLength;
			while (i < data.byteLength && data[i] !== 0) i++;
			headerLength = i + 1;
		}
		if (flg & 0b10000) {
			// FCOMMENT: zero-terminated string
			let i = headerLength;
			while (i < data.byteLength && data[i] !== 0) i++;
			headerLength = i + 1;
		}
		if (flg & 0b10) {
			// FHCRC: 2-byte header CRC
			headerLength += 2;
		}
		return inflateRawSync(data.subarray(headerLength));
	}
}

/**
 * Decode the TIKTIKPX/TIKTIPX pixel payload: gzip(TS) directly after the
 * magic (an older layout put a u32be prefix before the gzip stream).
 */
function decodeTiktipxPayload(raster: Uint8Array): Uint8Array {
	// The magic comes in an 8-byte (`TIKTIKPX`) and a 7-byte (`TIKTIPX`)
	// spelling, so locate the gzip stream itself (0x1f 0x8b) in the small
	// window after the magic. The decompressed size is the authority for the
	// TS length (a clean segment is a whole number of 188-byte packets); any
	// u32be alongside the magic is not reliably the output length on live
	// streams.
	let gzStart = -1;
	for (let i = 7; i <= 20 && i + 1 < raster.byteLength; i++) {
		if (raster[i] === 0x1f && raster[i + 1] === 0x8b) {
			gzStart = i;
			break;
		}
	}
	if (gzStart === -1) {
		throw new CamoUnwrapError(
			'TIKTIPX payload has no gzip stream after the magic',
			raster.byteLength,
			hexPrefix(raster)
		);
	}

	try {
		return gunzipTolerant(raster.subarray(gzStart));
	} catch (error) {
		throw new CamoUnwrapError(
			`TIKTIPX payload failed to gunzip: ${error instanceof Error ? error.message : String(error)}`,
			raster.byteLength,
			hexPrefix(raster)
		);
	}
}

function unknownContainerError(data: Uint8Array): CamoUnwrapError {
	return new CamoUnwrapError(
		'Unrecognized segment container (no known magic or TS sync bytes)',
		data.byteLength,
		hexPrefix(data)
	);
}

/**
 * Sniff a segment body and unwrap it to raw MPEG-TS.
 *
 * Plain TS passes through unchanged; anything that matches no container
 * throws CamoUnwrapError.
 */
export function unwrapCamoSegment(input: Uint8Array): CamoUnwrapResult {
	const data = input;

	if (data.length >= 12 && matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) {
		const payload = findWebpExifPayload(data);
		if (!payload || !looksLikeTsAt(payload, 0)) {
			throw new CamoUnwrapError(
				'WEBP segment has no EXIF chunk with a TS payload',
				data.byteLength,
				hexPrefix(data)
			);
		}
		return { data: payload, format: 'webp-exif' };
	}

	if (hasPngSignature(data)) {
		const afterIend = findPngPayloadAfterIend(data);
		if (afterIend && looksLikeTsAt(afterIend, 0)) {
			return { data: afterIend, format: 'png-iend' };
		}
		const decoded = decodePngRaster(data);
		if (
			decoded &&
			(matchesAscii(decoded.raster, 0, 'TIKTIKPX') || matchesAscii(decoded.raster, 0, 'TIKTIPX'))
		) {
			return { data: decodeTiktipxPayload(decoded.raster), format: 'png-tiktipx' };
		}
		throw new CamoUnwrapError(
			'PNG segment carries no TS payload after IEND and no TIKTIKPX pixels',
			data.byteLength,
			hexPrefix(data)
		);
	}

	if (matchesAscii(data, 0, 'TIKTIRAW')) {
		const payload = data.subarray(8);
		if (!looksLikeTsAt(payload, 0)) {
			throw new CamoUnwrapError('TIKTIRAW payload is not TS', data.byteLength, hexPrefix(data));
		}
		return { data: payload, format: 'tikti-raw' };
	}

	if (matchesAscii(data, 0, 'TIKTITSGZ')) {
		let ts: Uint8Array;
		try {
			ts = gunzipTolerant(data.subarray('TIKTITSGZ'.length));
		} catch (error) {
			throw new CamoUnwrapError(
				`TIKTITSGZ payload failed to gunzip: ${error instanceof Error ? error.message : String(error)}`,
				data.byteLength,
				hexPrefix(data)
			);
		}
		if (!looksLikeTsAt(ts, 0)) {
			throw new CamoUnwrapError('TIKTITSGZ payload is not TS', data.byteLength, hexPrefix(data));
		}
		return { data: ts, format: 'tikti-tsgz' };
	}

	if (looksLikeTsAt(data, 0)) {
		return { data, format: 'plain-ts' };
	}

	for (let i = 1; i + TS_PACKET_BYTES < data.length; i++) {
		if (looksLikeTsAt(data, i)) {
			return { data: data.subarray(i), format: 'ts-scan' };
		}
	}

	throw unknownContainerError(data);
}

const SNIFF_WINDOW_BYTES = 4096;

/**
 * Streaming unwrap for byte pipes (segment proxy). The first bytes decide the
 * fate of the whole body: plain TS streams through untouched, while container
 * formats (and unknown data) are buffered to the end of the segment and
 * unwrapped once complete.
 */
export function createCamoUnwrapTransform(
	options: {
		onFormat?: (format: CamoFormat) => void;
	} = {}
): TransformStream<Uint8Array, Uint8Array> {
	const { onFormat } = options;
	let mode: 'sniffing' | 'pass' | 'buffer' = 'sniffing';
	let buffered: Uint8Array[] = [];
	let bufferedBytes = 0;

	function concatBuffered(): Uint8Array {
		const out = new Uint8Array(bufferedBytes);
		let offset = 0;
		for (const chunk of buffered) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}

	/** Decide what to do with the body from its leading bytes. */
	function decide(head: Uint8Array): 'pass' | 'buffer' | 'wait' {
		if (
			head.length >= 8 &&
			(matchesAscii(head, 0, 'TIKTIRAW') || matchesAscii(head, 0, 'TIKTITSGZ'))
		) {
			return 'buffer';
		}
		if (head.length >= 12 && matchesAscii(head, 0, 'RIFF') && matchesAscii(head, 8, 'WEBP')) {
			return 'buffer';
		}
		if (head.length >= PNG_SIGNATURE.length && hasPngSignature(head)) {
			return 'buffer';
		}
		if (head.length >= TS_PACKET_BYTES * 2 && looksLikeTsAt(head, 0)) {
			return 'pass';
		}
		// Unknown so far: keep the head buffered; if nothing matches by the end
		// of the body the full sniff chain (incl. the ts-scan fallback) runs at
		// flush and errors when the container is genuinely unrecognized.
		return head.length >= SNIFF_WINDOW_BYTES ? 'buffer' : 'wait';
	}

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (mode === 'pass') {
				controller.enqueue(chunk);
				return;
			}
			buffered.push(chunk);
			bufferedBytes += chunk.byteLength;
			if (mode === 'buffer') return;

			const decision = decide(concatBuffered());
			if (decision === 'wait') return;
			if (decision === 'pass') {
				mode = 'pass';
				onFormat?.('plain-ts');
				const passthrough = concatBuffered();
				buffered = [];
				bufferedBytes = 0;
				controller.enqueue(passthrough);
				return;
			}
			mode = 'buffer';
		},
		flush(controller) {
			if (mode === 'pass') return;
			try {
				const result = unwrapCamoSegment(concatBuffered());
				onFormat?.(result.format);
				if (result.format !== 'plain-ts') {
					logger.debug(
						{ format: result.format, byteLength: bufferedBytes },
						'[CamoUnwrap] Unwrapped camouflaged segment'
					);
				}
				controller.enqueue(result.data);
			} catch (error) {
				controller.error(error);
			} finally {
				buffered = [];
				bufferedBytes = 0;
			}
		}
	});
}
