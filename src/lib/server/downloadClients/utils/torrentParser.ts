/**
 * Torrent file parser utilities.
 *
 * Parses .torrent files to extract info hashes and detects magnet link redirects.
 * Used by the DownloadResolutionService to process downloads fetched from indexers.
 */

import parseTorrent from 'parse-torrent';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'torrentParser' });

/**
 * Result of parsing a torrent file or detecting a magnet redirect.
 */
export interface TorrentParseResult {
	/** Whether parsing was successful */
	success: boolean;
	/** The info hash in lowercase hex format (40 characters) */
	infoHash?: string;
	/** If the data was actually a magnet link redirect */
	magnetUrl?: string;
	/** The torrent name from metadata */
	name?: string;
	/** Error message if parsing failed */
	error?: string;
}

/**
 * Check if a byte array starts with "magnet:" (ASCII).
 * This indicates the indexer returned a magnet link instead of a torrent file.
 */
function isMagnetRedirect(data: Buffer | Uint8Array): boolean {
	// "magnet:" in ASCII is [109, 97, 103, 110, 101, 116, 58]
	if (data.length < 7) return false;
	return (
		data[0] === 0x6d && // m
		data[1] === 0x61 && // a
		data[2] === 0x67 && // g
		data[3] === 0x6e && // n
		data[4] === 0x65 && // e
		data[5] === 0x74 && // t
		data[6] === 0x3a // :
	);
}

/**
 * Parse a torrent file and extract the info hash.
 *
 * If the data is actually a magnet link (redirect), returns that instead.
 *
 * @param data - The raw torrent file data
 * @returns Parse result with info hash or magnet URL
 */
export async function parseTorrentFile(data: Buffer | Uint8Array): Promise<TorrentParseResult> {
	try {
		// Check if this is actually a magnet link redirect
		if (isMagnetRedirect(data)) {
			const magnetUrl = Buffer.from(data).toString('utf-8').trim();
			logger.debug(
				{
					magnetUrl: magnetUrl.substring(0, 100)
				},
				'Data is magnet redirect, not torrent file'
			);

			// Extract info hash from magnet URL
			const infoHash = await extractInfoHashFromMagnet(magnetUrl);

			return {
				success: true,
				magnetUrl,
				infoHash
			};
		}

		// Parse as torrent file (parse-torrent v11+ is async)
		const torrent = await parseTorrent(Buffer.from(data));

		if (!torrent || !torrent.infoHash) {
			logger.warn(
				{
					dataLength: data.length,
					firstChars: Buffer.from(data)
						.subarray(0, 80)
						.toString('utf-8')
						.replace(/[^\x20-\x7e]/g, '?')
				},
				'Torrent parse returned no info hash'
			);
			return {
				success: false,
				error: 'Failed to parse torrent file: no info hash found'
			};
		}

		logger.debug(
			{
				infoHash: torrent.infoHash,
				name: Array.isArray(torrent.name) ? torrent.name[0] : torrent.name
			},
			'Parsed torrent file'
		);

		return {
			success: true,
			infoHash: torrent.infoHash.toLowerCase(),
			name: Array.isArray(torrent.name) ? torrent.name[0] : torrent.name
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(
			{
				error: message,
				dataLength: data.length,
				firstChars: Buffer.from(data)
					.subarray(0, 80)
					.toString('utf-8')
					.replace(/[^\x20-\x7e]/g, '?')
			},
			'Failed to parse torrent file'
		);

		return {
			success: false,
			error: `Failed to parse torrent file: ${message}`
		};
	}
}

/**
 * Extract info hash from a magnet URL.
 *
 * Handles both v1 (40-char hex) and v2 (32-char base32) formats.
 *
 * @param magnetUrl - The magnet URL to parse
 * @returns The info hash in lowercase hex, or undefined if not found
 */
export async function extractInfoHashFromMagnet(magnetUrl: string): Promise<string | undefined> {
	try {
		// Try hex format first (40 chars) — sync regex, no need for async
		const hexMatch = magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
		if (hexMatch) {
			return hexMatch[1].toLowerCase();
		}

		// Try base32 format (32 chars) and convert to hex
		const base32Match = magnetUrl.match(/xt=urn:btih:([A-Z2-7]{32})/i);
		if (base32Match) {
			return base32ToHex(base32Match[1].toUpperCase());
		}

		// Use parse-torrent as fallback (async in v11+)
		const parsed = await parseTorrent(magnetUrl);
		if (parsed?.infoHash) {
			return parsed.infoHash.toLowerCase();
		}

		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Convert base32 encoded hash to hex.
 */
function base32ToHex(base32: string): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';

	for (const char of base32) {
		const val = alphabet.indexOf(char.toUpperCase());
		if (val === -1) continue;
		bits += val.toString(2).padStart(5, '0');
	}

	let hex = '';
	for (let i = 0; i < bits.length - 3; i += 4) {
		hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
	}

	return hex.toLowerCase();
}

/**
 * Parse a magnet URL and extract metadata.
 *
 * @param magnetUrl - The magnet URL to parse
 * @returns Parse result with info hash
 */
export async function parseMagnetUrl(magnetUrl: string): Promise<TorrentParseResult> {
	try {
		const parsed = await parseTorrent(magnetUrl);

		if (!parsed || !parsed.infoHash) {
			return {
				success: false,
				error: 'Failed to parse magnet URL: no info hash found'
			};
		}

		return {
			success: true,
			infoHash: parsed.infoHash.toLowerCase(),
			magnetUrl,
			name: Array.isArray(parsed.name) ? parsed.name[0] : parsed.name
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to parse magnet URL: ${message}`
		};
	}
}

/**
 * Check if data looks like a valid torrent file (starts with 'd').
 * Bencoded dictionaries start with 'd'.
 */
export function looksLikeTorrentFile(data: Buffer | Uint8Array): boolean {
	return data.length > 0 && data[0] === 0x64; // 'd' in ASCII
}

/**
 * Build a magnet URL from an info hash with default trackers.
 *
 * @param infoHash - The info hash (hex format)
 * @param name - Optional torrent name
 * @returns A magnet URL with trackers
 */
export function buildMagnetFromInfoHash(infoHash: string, name?: string): string {
	const trackers = [
		'udp://tracker.opentrackr.org:1337/announce',
		'udp://open.stealth.si:80/announce',
		'udp://tracker.torrent.eu.org:451/announce',
		'udp://tracker.bittor.pw:1337/announce',
		'udp://public.popcorn-tracker.org:6969/announce',
		'udp://tracker.dler.org:6969/announce',
		'udp://exodus.desync.com:6969',
		'udp://open.demonii.com:1337/announce'
	];

	let magnet = `magnet:?xt=urn:btih:${infoHash.toLowerCase()}`;

	if (name) {
		magnet += `&dn=${encodeURIComponent(name)}`;
	}

	for (const tracker of trackers) {
		magnet += `&tr=${encodeURIComponent(tracker)}`;
	}

	return magnet;
}
