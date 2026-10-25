/**
 * M3U Playlist Generator for Live TV
 *
 * Generates an M3U playlist for Plex/Jellyfin/Emby consumption.
 * Each channel in the user's lineup is listed with proxy URLs that point
 * to the stream proxy endpoint (/api/livetv/stream/:lineupId).
 *
 * IMPORTANT: Channel URLs use the default stream proxy mode (no format param),
 * which triggers server-side HLS-to-TS conversion. This is intentional:
 * media servers' M3U tuners expect a continuous MPEG-TS byte stream, not an
 * HLS playlist. The stream proxy handles the conversion transparently.
 *
 * Previously, URLs included ?format=ts which piped raw TS directly, but this
 * caused 30-45 second replay loops on stalker portal providers due to their
 * single-use play_token and buffer-origin restart behavior.
 *
 * GET /api/livetv/playlist.m3u
 * GET /api/livetv/playlist.m3u?category=<categoryId>
 */

import type { RequestHandler } from './$types';
import { channelLineupService } from '#lib/server/livetv/lineup/ChannelLineupService.js';
import { getBaseUrlAsync } from '#lib/server/streaming/url.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { ChannelLineupItemWithDetails } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvPlaylistM3u', logDomain: 'livetv' });

/**
 * Build an M3U playlist from lineup items
 * @param lineup - Channel lineup items
 * @param baseUrl - Base URL for the server
 * @param apiKey - Optional API key to embed in channel URLs for authentication
 */
function buildM3UPlaylist(
	lineup: ChannelLineupItemWithDetails[],
	baseUrl: string,
	apiKey?: string
): string {
	const lines: string[] = ['#EXTM3U'];

	for (const item of lineup) {
		// Build EXTINF attributes
		const tvgId = item.epgId || item.id;
		const tvgName = item.displayName;
		const tvgLogo = item.displayLogo || '';
		const groupTitle = item.category?.name || 'Uncategorized';
		const chno = item.channelNumber ?? item.position;

		// EXTINF line with metadata
		// Format: #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-chno="..." tvg-logo="..." group-title="...",Display Name
		const extinf = [
			'#EXTINF:-1',
			`tvg-id="${escapeM3UAttribute(tvgId)}"`,
			`tvg-name="${escapeM3UAttribute(tvgName)}"`,
			`tvg-chno="${chno}"`,
			tvgLogo ? `tvg-logo="${escapeM3UAttribute(tvgLogo)}"` : '',
			`group-title="${escapeM3UAttribute(groupTitle)}"`
		]
			.filter(Boolean)
			.join(' ');

		lines.push(`${extinf},${tvgName}`);

		// Proxy URL - media servers will request this
		// Append .ts extension so Jellyfin/Emby auto-detect as MPEG-TS format.
		// Without extension, Jellyfin defaults to -f hls which causes format mismatch errors.
		let channelUrl = `${baseUrl}/api/livetv/stream/${item.id}.ts`;

		// Embed API key in URL if provided (for media server authentication)
		if (apiKey) {
			channelUrl += `?api_key=${encodeURIComponent(apiKey)}`;
		}

		lines.push(channelUrl);
	}

	return lines.join('\n');
}

/**
 * Escape special characters in M3U attribute values
 */
function escapeM3UAttribute(value: string): string {
	return value
		.replace(/"/g, "'") // Replace double quotes with single
		.replace(/\n/g, ' ') // Remove newlines
		.replace(/\r/g, ''); // Remove carriage returns
}

export const GET: RequestHandler = async ({ request, url }) => {
	try {
		const baseUrl = await getBaseUrlAsync(request);
		const categoryId = url.searchParams.get('category');

		// Extract API key from query params (for embedding in channel URLs)
		// This allows media servers (Jellyfin/Plex/Emby) to authenticate stream requests
		const apiKey = url.searchParams.get('api_key') || undefined;

		// Get user's lineup ordered by position
		let lineup = await channelLineupService.getLineup();

		// Filter by category if specified
		if (categoryId) {
			lineup = lineup.filter((item) => item.categoryId === categoryId);
		}

		if (lineup.length === 0) {
			logger.debug('[Playlist] No channels in lineup');
			return new Response('#EXTM3U\n# No channels in lineup', {
				status: 200,
				headers: {
					'Content-Type': 'audio/x-mpegurl',
					'Content-Disposition': 'inline; filename="cinephage-livetv.m3u"',
					'Access-Control-Allow-Origin': '*'
				}
			});
		}

		// Build M3U playlist (embed API key in channel URLs if provided)
		const m3u = buildM3UPlaylist(lineup, baseUrl, apiKey);

		logger.debug(
			{
				channels: lineup.length,
				categoryFilter: categoryId || 'none'
			},
			'[Playlist] Generated M3U playlist'
		);

		return new Response(m3u, {
			status: 200,
			headers: {
				'Content-Type': 'audio/x-mpegurl',
				'Content-Disposition': 'inline; filename="cinephage-livetv.m3u"',
				'Cache-Control': 'no-cache',
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type'
			}
		});
	} catch (error) {
		logger.error('[Playlist] Failed to generate playlist', error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : 'Failed to generate playlist'
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		}
	});
};
