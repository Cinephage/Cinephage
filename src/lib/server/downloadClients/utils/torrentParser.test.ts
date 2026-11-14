import { describe, expect, it } from 'vitest';
import { looksLikeTorrentFile, parseTorrentFile } from './torrentParser';

function htmlPage(): Buffer {
	// Shape of a tracker page served in place of a .torrent: what RuTracker's
	// dl.php returns to a browser it has flagged.
	return Buffer.from(
		'<!DOCTYPE html>\n<html><head><title>RuTracker</title></head><body>Please log in</body></html>',
		'utf-8'
	);
}

describe('looksLikeTorrentFile', () => {
	it('accepts a bencoded dictionary', () => {
		expect(looksLikeTorrentFile(Buffer.from('d8:announce'))).toBe(true);
	});

	it('rejects a page, empty data and other formats', () => {
		expect(looksLikeTorrentFile(htmlPage())).toBe(false);
		expect(looksLikeTorrentFile(Buffer.alloc(0))).toBe(false);
		expect(looksLikeTorrentFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
	});
});

describe('parseTorrentFile', () => {
	it('classifies an HTML page as a non-torrent payload, not a parse failure', async () => {
		const result = await parseTorrentFile(htmlPage());

		expect(result.success).toBe(false);
		expect(result.error).toContain('non-torrent payload');
		expect(result.error).toContain('bytes');
	});
});
