import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectAudioFiles, MIN_AUDIO_BYTES, readAudioTags } from './audio-folder.js';

/** A RIFF sub-chunk, padded to an even length as the format requires. */
function chunk(id: string, body: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.write(id, 0, 'ascii');
	header.writeUInt32LE(body.length, 4);
	const padding = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
	return Buffer.concat([header, body, padding]);
}

/** A PCM WAV file with a LIST/INFO tag block, as real rippers write it. */
function taggedWav(tags: Record<string, string>, seconds: number): Buffer {
	const sampleRate = 44100;
	const channels = 2;
	const bitsPerSample = 16;
	const blockAlign = (channels * bitsPerSample) / 8;

	const fmt = Buffer.alloc(16);
	fmt.writeUInt16LE(1, 0); // PCM
	fmt.writeUInt16LE(channels, 2);
	fmt.writeUInt32LE(sampleRate, 4);
	fmt.writeUInt32LE(sampleRate * blockAlign, 8);
	fmt.writeUInt16LE(blockAlign, 12);
	fmt.writeUInt16LE(bitsPerSample, 14);

	const info = Buffer.concat([
		Buffer.from('INFO', 'ascii'),
		...Object.entries(tags).map(([id, value]) => chunk(id, Buffer.from(`${value}\0`, 'utf8')))
	]);

	const body = Buffer.concat([
		Buffer.from('WAVE', 'ascii'),
		chunk('fmt ', fmt),
		chunk('LIST', info),
		chunk('data', Buffer.alloc(sampleRate * blockAlign * seconds))
	]);
	const riff = Buffer.alloc(8);
	riff.write('RIFF', 0, 'ascii');
	riff.writeUInt32LE(body.length, 4);
	return Buffer.concat([riff, body]);
}

describe('reading tags from audio files on disk', () => {
	let root: string;

	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'audio-folder-tags-'));
		const album = path.join(root, 'Artist', 'Album (2001)');
		await mkdir(album, { recursive: true });
		await writeFile(
			path.join(album, '01 - One.wav'),
			taggedWav({ INAM: 'One', IART: 'Artist', IPRD: 'Album', ICRD: '2001', ITRK: '1' }, 1)
		);
		// Big enough to pass the size gate, but not audio: the tag read must fail softly.
		await writeFile(path.join(album, '02 - Broken.flac'), Buffer.alloc(MIN_AUDIO_BYTES, 0x41));
		// Too small to be audio at all.
		await writeFile(path.join(album, '03 - Stub.mp3'), Buffer.alloc(16));
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('reads the common tags and the stream format', async () => {
		const file = path.join(root, 'Artist', 'Album (2001)', '01 - One.wav');
		const tags = await readAudioTags(file, '01 - One.wav', '01 - One.wav', 0);

		expect(tags).toMatchObject({
			title: 'One',
			artist: 'Artist',
			album: 'Album',
			year: 2001,
			trackNumber: 1,
			format: 'WAVE',
			bitDepth: 16,
			sampleRateHz: 44100,
			channels: 2,
			durationSeconds: 1,
			bitrateKbps: 1411
		});
	});

	it('keeps a file whose tags cannot be read, with empty tags', async () => {
		const file = path.join(root, 'Artist', 'Album (2001)', '02 - Broken.flac');
		const tags = await readAudioTags(file, '02 - Broken.flac', '02 - Broken.flac', MIN_AUDIO_BYTES);

		expect(tags.absolutePath).toBe(file);
		expect(tags.title).toBeNull();
		expect(tags.album).toBeNull();
		expect(tags.durationSeconds).toBeNull();
	});

	it('walks a folder, tagging audio and skipping stubs', async () => {
		const files = await collectAudioFiles(root);

		expect(files.map((file) => file.fileName).sort()).toEqual(['01 - One.wav', '02 - Broken.flac']);
		expect(files.find((file) => file.fileName === '01 - One.wav')?.album).toBe('Album');
	});
});
