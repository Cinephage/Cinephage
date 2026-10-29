import { describe, expect, it } from 'vitest';
import { crc32, deflateRawSync } from 'node:zlib';
import { gzipSync, zlibSync } from 'fflate';
import { CamoUnwrapError, createCamoUnwrapTransform, unwrapCamoSegment } from './camo-unwrap';

const TS_PACKET_BYTES = 188;

/** Build `count` well-formed TS packets (sync byte + filler payload). */
function tsPackets(count: number, fill = 0x10): Uint8Array {
	const out = new Uint8Array(count * TS_PACKET_BYTES);
	for (let i = 0; i < count; i++) {
		out[i * TS_PACKET_BYTES] = 0x47;
		out.fill(fill + (i % 16), i * TS_PACKET_BYTES + 1, (i + 1) * TS_PACKET_BYTES);
	}
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function ascii(text: string): Uint8Array {
	return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

// ============================================================================
// Container fixture builders
// ============================================================================

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
	const header = new Uint8Array(8);
	header.set(ascii(fourcc), 0);
	new DataView(header.buffer).setUint32(4, data.byteLength, true);
	return concat([header, data, data.byteLength % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

function webpContainer(exifPayload: Uint8Array): Uint8Array {
	// Odd-sized ICCP chunk proves the walker skips padding correctly.
	const chunks = [riffChunk('ICCP', ascii('abc')), riffChunk('EXIF', exifPayload)];
	const body = concat([ascii('WEBP'), ...chunks]);
	const header = new Uint8Array(12);
	header.set(ascii('RIFF'), 0);
	new DataView(header.buffer).setUint32(4, body.byteLength, true);
	header.set(ascii('WEBP'), 8);
	return concat([header, ...chunks]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const header = new Uint8Array(8);
	header.set(ascii(type), 4);
	new DataView(header.buffer).setUint32(0, data.byteLength);
	// CRC is appended but the unwrap never validates it.
	return concat([header, data, new Uint8Array(4)]);
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngIendContainer(payload: Uint8Array): Uint8Array {
	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, 4);
	new DataView(ihdr.buffer).setUint32(4, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return concat([
		PNG_SIGNATURE,
		pngChunk('IHDR', ihdr),
		pngChunk('tEXt', ascii('Title\0decoy')),
		pngChunk('IEND', new Uint8Array(0)),
		payload
	]);
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * Build a PNG around a pre-built reconstructed raster, forward-filtering each
 * row (inverse of the decoder's unfiltering) and cycling through all five PNG
 * filter types so the decoder's unfiltering (including Paeth) is exercised
 * end-to-end.
 */
function pngWithRaster(
	raster: Uint8Array,
	width: number,
	height: number,
	colorType: 2 | 6
): Uint8Array {
	const bpp = colorType === 2 ? 3 : 4;
	const stride = width * bpp;
	if (raster.byteLength !== height * stride) {
		throw new Error(`raster must be exactly ${height * stride} bytes`);
	}

	const scanlines: Uint8Array[] = [];
	for (let y = 0; y < height; y++) {
		const filter = y % 5;
		const row = raster.subarray(y * stride, (y + 1) * stride);
		const previousRow = y > 0 ? raster.subarray((y - 1) * stride, y * stride) : null;
		const filtered = new Uint8Array(stride);
		for (let x = 0; x < stride; x++) {
			const left = x >= bpp ? row[x - bpp] : 0;
			const up = previousRow ? previousRow[x] : 0;
			const upLeft = previousRow && x >= bpp ? previousRow[x - bpp] : 0;
			let predictor = 0;
			switch (filter) {
				case 1:
					predictor = left;
					break;
				case 2:
					predictor = up;
					break;
				case 3:
					predictor = (left + up) >> 1;
					break;
				case 4:
					predictor = paeth(left, up, upLeft);
					break;
			}
			filtered[x] = (row[x] - predictor) & 0xff;
		}
		const scanline = new Uint8Array(stride + 1);
		scanline[0] = filter;
		scanline.set(filtered, 1);
		scanlines.push(scanline);
	}

	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, width);
	new DataView(ihdr.buffer).setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = colorType;
	ihdr[12] = 0; // no interlace

	return concat([
		PNG_SIGNATURE,
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlibSync(concat(scanlines))),
		pngChunk('IEND', new Uint8Array(0))
	]);
}

/**
 * Length-prefixed TIKTIKPX raster content (magic + u32be length + gzip).
 * The live upstream spells the magic `TIKTIKPX` (8 bytes); older experiments
 * used the 7-byte `TIKTIPX` — both must decode.
 */
function tiktipxRasterContent(ts: Uint8Array, magic = 'TIKTIKPX'): Uint8Array {
	const gz = gzipSync(ts);
	const lengthPrefix = new Uint8Array(4);
	new DataView(lengthPrefix.buffer).setUint32(0, ts.byteLength);
	return concat([ascii(magic), lengthPrefix, gz]);
}

function pngTiktipxContainer(
	ts: Uint8Array,
	options: { width: number; height: number; colorType: 2 | 6; magic?: string } = {
		width: 64,
		height: 16,
		colorType: 2
	}
): Uint8Array {
	const bpp = options.colorType === 2 ? 3 : 4;
	const stride = options.width * bpp;
	const raster = new Uint8Array(options.height * stride);
	raster.set(tiktipxRasterContent(ts, options.magic), 0);
	return pngWithRaster(raster, options.width, options.height, options.colorType);
}

// ============================================================================
// unwrapCamoSegment
// ============================================================================

describe('unwrapCamoSegment', () => {
	it('passes plain TS through untouched', () => {
		const ts = tsPackets(4);
		const result = unwrapCamoSegment(ts);
		expect(result.format).toBe('plain-ts');
		expect(result.data).toBe(ts);
	});

	it('unwraps a WEBP/RIFF EXIF chunk (format 1)', () => {
		const ts = tsPackets(3);
		const container = webpContainer(ts);
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('webp-exif');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('unwraps bytes after the PNG IEND chunk (format 2)', () => {
		const ts = tsPackets(3);
		const container = pngIendContainer(ts);
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('png-iend');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('decodes TIKTIKPX PNG pixels incl. all filters and gunzips the TS (format 3)', () => {
		const ts = tsPackets(6);
		for (const colorType of [2, 6] as const) {
			const container = pngTiktipxContainer(ts, { width: 64, height: 16, colorType });
			const result = unwrapCamoSegment(container);
			expect(result.format).toBe('png-tiktipx');
			expect(Array.from(result.data)).toEqual(Array.from(ts));
		}
	});

	it('handles the legacy 7-byte TIKTIPX magic spelling', () => {
		const ts = tsPackets(4);
		const container = pngTiktipxContainer(ts, {
			width: 64,
			height: 16,
			colorType: 2,
			magic: 'TIKTIPX'
		});
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('png-tiktipx');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('prefers png-iend when both it and TIKTIKPX pixels would apply', () => {
		// A PNG whose own pixels carry a valid TIKTIPX payload AND whose
		// after-IEND bytes are raw TS: the sniff order must return the
		// trailing TS (format 2 outranks format 3).
		const ts = tsPackets(3);
		const pixelPayload = tsPackets(2, 0x30);
		const stride = 64 * 3;
		const raster = new Uint8Array(16 * stride);
		raster.set(tiktipxRasterContent(pixelPayload), 0);
		const pngBody = pngWithRaster(raster, 64, 16, 2);
		// pngWithRaster ends with the IEND chunk (12 bytes); re-append it
		// ourselves so the raw TS payload can follow.
		const withoutIend = pngBody.subarray(0, pngBody.byteLength - 12);
		const container = concat([withoutIend, pngChunk('IEND', new Uint8Array(0)), ts]);
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('png-iend');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('unwraps raw TS after the TIKTIRAW marker (format 4)', () => {
		const ts = tsPackets(3);
		const container = concat([ascii('TIKTIRAW'), ts]);
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('tikti-raw');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('gunzips TS after the TIKTITSGZ marker (format 5)', () => {
		const ts = tsPackets(3);
		const container = concat([ascii('TIKTITSGZ'), gzipSync(ts)]);
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('tikti-tsgz');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('recovers a gzip stream whose trailer length is wrong (node zlib rejects it)', () => {
		// The live upstream's gzip members carry unreliable length bookkeeping
		// (the real stream's ISIZE disagreed with its own data), so node zlib's
		// strict gunzip fails "incorrect length check" and the raw-inflate
		// fallback must recover the payload.
		const ts = tsPackets(4);
		const raw = deflateRawSync(ts);
		const header = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0]);
		const trailer = new Uint8Array(8);
		new DataView(trailer.buffer).setUint32(0, crc32(ts));
		new DataView(trailer.buffer).setUint32(4, ts.byteLength - 141); // wrong ISIZE
		const container = concat([ascii('TIKTITSGZ'), header, raw, trailer]);

		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('tikti-tsgz');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('scans forward to the first TS sync pair (format 6)', () => {
		const junk = ascii('<html>404 not found</html>');
		const ts = tsPackets(3);
		const container = concat([junk, ts]);
		const result = unwrapCamoSegment(container);
		expect(result.format).toBe('ts-scan');
		expect(Array.from(result.data)).toEqual(Array.from(ts));
	});

	it('throws CamoUnwrapError with a hex prefix for unknown containers', () => {
		const garbage = concat([
			ascii('<!doctype html><html><body>error</body>'),
			new Uint8Array(64).fill(0x61)
		]);
		try {
			unwrapCamoSegment(garbage);
			expect.unreachable('expected CamoUnwrapError');
		} catch (error) {
			expect(error).toBeInstanceOf(CamoUnwrapError);
			const camoError = error as CamoUnwrapError;
			expect(camoError.prefixHex).toMatch(/^[0-9a-f]{2}( [0-9a-f]{2})*$/);
			expect(camoError.byteLength).toBe(garbage.byteLength);
		}
	});

	it('throws when a WEBP container has no EXIF chunk', () => {
		const container = webpContainer(ascii('not ts at all'));
		expect(() => unwrapCamoSegment(container)).toThrow(CamoUnwrapError);
	});

	it('throws when a PNG has neither TS after IEND nor TIKTIKPX pixels', () => {
		const container = pngIendContainer(ascii('trailing junk, not ts'));
		expect(() => unwrapCamoSegment(container)).toThrow(CamoUnwrapError);
	});
});

// ============================================================================
// createCamoUnwrapTransform
// ============================================================================

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return concat(chunks);
}

function feed(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});
}

describe('createCamoUnwrapTransform', () => {
	it('streams plain TS chunks through without buffering the whole body', async () => {
		const formats: string[] = [];
		const chunkA = tsPackets(2);
		const chunkB = tsPackets(2, 0x20);
		const output = await collect(
			feed([chunkA, chunkB]).pipeThrough(
				createCamoUnwrapTransform({ onFormat: (format) => formats.push(format) })
			)
		);
		expect(formats).toEqual(['plain-ts']);
		expect(Array.from(output)).toEqual(Array.from(concat([chunkA, chunkB])));
	});

	it('unwraps a marker payload split across tiny chunks', async () => {
		const formats: string[] = [];
		const ts = tsPackets(3);
		const container = concat([ascii('TIKTITSGZ'), gzipSync(ts)]);
		const tinyChunks: Uint8Array[] = [];
		for (let i = 0; i < container.byteLength; i += 64) {
			tinyChunks.push(container.subarray(i, i + 64));
		}
		const output = await collect(
			feed(tinyChunks).pipeThrough(
				createCamoUnwrapTransform({ onFormat: (format) => formats.push(format) })
			)
		);
		expect(formats).toEqual(['tikti-tsgz']);
		expect(Array.from(output)).toEqual(Array.from(ts));
	});

	it('unwraps a TIKTIKPX PNG split across tiny chunks', async () => {
		const ts = tsPackets(6);
		const container = pngTiktipxContainer(ts, { width: 64, height: 16, colorType: 2 });
		const tinyChunks: Uint8Array[] = [];
		for (let i = 0; i < container.byteLength; i += 37) {
			tinyChunks.push(container.subarray(i, i + 37));
		}
		const output = await collect(feed(tinyChunks).pipeThrough(createCamoUnwrapTransform()));
		expect(Array.from(output)).toEqual(Array.from(ts));
	});

	it('errors the stream for an unknown container', async () => {
		const garbage = concat([ascii('<!doctype html>'), new Uint8Array(512).fill(0x62)]);
		const read = collect(feed([garbage]).pipeThrough(createCamoUnwrapTransform()));
		await expect(read).rejects.toBeInstanceOf(CamoUnwrapError);
	});
});
