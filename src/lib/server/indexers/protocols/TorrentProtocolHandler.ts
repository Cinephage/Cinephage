/**
 * Torrent Protocol Handler
 *
 * Handles torrent-specific operations including:
 * - Magnet URL generation
 * - Seeder/leecher health calculation
 * - Freeleech detection
 * - Torrent scoring adjustments
 */

import {
	BaseProtocolHandler,
	type ITorrentHandler,
	type TorrentHealth,
	type ProtocolContext,
	type ProtocolDisplayInfo
} from './IProtocolHandler';
import type { ReleaseResult, EnhancedReleaseResult } from '../types/release';
import type { TorrentProtocolSettings } from '../types/protocol';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Score bonuses for torrent-specific features
 */
const TORRENT_SCORE_BONUSES = {
	internalRelease: 30,
	highSeeders: 20, // > 100 seeders
	excellentHealth: 15,
	goodHealth: 10,
	fairHealth: 5
};

/**
 * Score penalties for torrent issues
 */
const TORRENT_SCORE_PENALTIES = {
	deadTorrent: -100,
	poorHealth: -20,
	noSeeders: -50
};

/**
 * Health thresholds
 */
const HEALTH_THRESHOLDS = {
	excellent: 50, // 50+ seeders
	good: 20, // 20-49 seeders
	fair: 5, // 5-19 seeders
	poor: 1 // 1-4 seeders
	// 0 seeders = dead
};

// =============================================================================
// TORRENT PROTOCOL HANDLER
// =============================================================================

export class TorrentProtocolHandler extends BaseProtocolHandler implements ITorrentHandler {
	readonly protocol = 'torrent' as const;

	/**
	 * Validate torrent-specific fields
	 */
	override validateResult(result: ReleaseResult): boolean {
		if (!super.validateResult(result)) {
			return false;
		}

		// Torrent needs either a downloadUrl or magnetUrl
		const hasTorrentFile = result.downloadUrl && !result.downloadUrl.startsWith('magnet:');
		const hasMagnet =
			result.downloadUrl?.startsWith('magnet:') || result.magnetUrl || result.torrent?.magnetUrl;

		if (!hasTorrentFile && !hasMagnet) {
			return false;
		}

		return true;
	}

	/**
	 * Extract torrent-specific metadata
	 */
	extractMetadata(result: ReleaseResult): Record<string, unknown> {
		const torrent = result.torrent;
		return {
			seeders: torrent?.seeders ?? result.seeders ?? 0,
			leechers: torrent?.leechers ?? result.leechers ?? 0,
			grabs: torrent?.grabs ?? result.grabs ?? 0,
			infoHash: torrent?.infoHash ?? result.infoHash,
			magnetUrl: this.getMagnetUrl(result),
			isFreeleech: this.isFreeleech(result),
			uploadFactor: torrent?.uploadFactor ?? 1,
			downloadFactor: torrent?.downloadFactor ?? 1,
			isInternal: torrent?.isInternal ?? false,
			minimumRatio: torrent?.minimumRatio,
			minimumSeedTime: torrent?.minimumSeedTime
		};
	}

	/**
	 * Calculate score adjustment based on torrent health and features
	 */
	calculateScoreAdjustment(result: EnhancedReleaseResult, context: ProtocolContext): number {
		let adjustment = 0;
		const settings = context.settings as TorrentProtocolSettings;

		// Get seeder/leecher info
		const seeders = result.seeders;
		const leechers = result.leechers ?? 0;

		// Apply seeder-based adjustments only when the indexer reported seeder metadata.
		if (seeders !== undefined) {
			const health = this.calculateHealth(seeders, leechers);
			switch (health.level) {
				case 'dead':
					adjustment += TORRENT_SCORE_PENALTIES.deadTorrent;
					break;
				case 'poor':
					adjustment += TORRENT_SCORE_PENALTIES.poorHealth;
					break;
				case 'fair':
					adjustment += TORRENT_SCORE_BONUSES.fairHealth;
					break;
				case 'good':
					adjustment += TORRENT_SCORE_BONUSES.goodHealth;
					break;
				case 'excellent':
					adjustment += TORRENT_SCORE_BONUSES.excellentHealth;
					if (seeders > 100) {
						adjustment += TORRENT_SCORE_BONUSES.highSeeders;
					}
					break;
			}

			// Apply minimum seeders requirement from settings
			if (settings.minimumSeeders !== undefined && seeders < settings.minimumSeeders) {
				// Heavy penalty for not meeting minimum seeders
				adjustment += TORRENT_SCORE_PENALTIES.noSeeders;
			}
		}

		// Internal release bonus
		if (result.torrent?.isInternal) {
			adjustment += TORRENT_SCORE_BONUSES.internalRelease;
		}

		return adjustment;
	}

	/**
	 * Generate download URL
	 * Always returns the direct download URL to ensure private tracker compatibility.
	 * We never prefer magnet links as they break private trackers like nCore.
	 */
	override async generateDownloadUrl(
		result: ReleaseResult,
		_context: ProtocolContext
	): Promise<string> {
		// Always use the direct download URL
		// This ensures we get the .torrent file with private tracker announce URLs
		return result.downloadUrl;
	}

	/**
	 * Check if torrent should be rejected
	 */
	shouldReject(result: EnhancedReleaseResult, context: ProtocolContext): string | undefined {
		const settings = context.settings as TorrentProtocolSettings;
		const seeders = result.seeders;

		// Apply seeder validation only when the indexer reported seeders.
		if (seeders !== undefined) {
			// Reject dead torrents if required
			if (settings.rejectDeadTorrents && seeders === 0) {
				return 'No seeders available';
			}

			// Reject below minimum seeders
			if (settings.minimumSeeders !== undefined && seeders < settings.minimumSeeders) {
				return `Below minimum seeders (${seeders} < ${settings.minimumSeeders})`;
			}
		}

		// Reject above maximum size
		if (settings.maximumSize !== undefined && result.size > settings.maximumSize) {
			return `Exceeds maximum size (${this.formatSizeDisplay(result.size)})`;
		}

		return undefined;
	}

	/**
	 * Get display information for UI
	 */
	getDisplayInfo(result: ReleaseResult): ProtocolDisplayInfo {
		const seeders = result.torrent?.seeders ?? result.seeders ?? 0;
		const leechers = result.torrent?.leechers ?? result.leechers ?? 0;
		const grabs = result.torrent?.grabs ?? result.grabs;
		const health = this.calculateHealth(seeders, leechers);

		const details: ProtocolDisplayInfo['details'] = [
			{
				label: 'Seeders',
				value: seeders.toString(),
				tooltip: `${seeders} seeders currently available`
			},
			{
				label: 'Leechers',
				value: leechers.toString(),
				tooltip: `${leechers} leechers currently downloading`
			}
		];

		if (grabs !== undefined) {
			details.push({
				label: 'Grabs',
				value: grabs.toString(),
				tooltip: `Downloaded ${grabs} times`
			});
		}

		if (this.isFreeleech(result)) {
			details.push({
				label: 'Freeleech',
				value: 'Yes',
				tooltip: 'This torrent does not count against your download ratio'
			});
		}

		if (result.torrent?.isInternal) {
			details.push({
				label: 'Internal',
				value: 'Yes',
				tooltip: 'Internal tracker release'
			});
		}

		return {
			badge: 'TORRENT',
			badgeClass: this.getHealthBadgeClass(health.level),
			icon: 'download',
			availability: `${seeders}S / ${leechers}L`,
			details
		};
	}

	// =========================================================================
	// TORRENT-SPECIFIC METHODS
	// =========================================================================

	/**
	 * Get or generate magnet URL
	 */
	getMagnetUrl(result: ReleaseResult): string | undefined {
		// Check existing magnet sources
		if (result.downloadUrl?.startsWith('magnet:')) {
			return result.downloadUrl;
		}
		if (result.magnetUrl) {
			return result.magnetUrl;
		}
		if (result.torrent?.magnetUrl) {
			return result.torrent.magnetUrl;
		}

		// Generate magnet from info hash if available
		const infoHash = result.torrent?.infoHash ?? result.infoHash;
		if (infoHash) {
			return this.generateMagnetFromHash(infoHash, result.title);
		}

		return undefined;
	}

	/**
	 * Generate magnet URL from info hash
	 */
	private generateMagnetFromHash(infoHash: string, title: string): string {
		const encodedTitle = encodeURIComponent(title);
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

		const trackerParams = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');

		return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedTitle}${trackerParams}`;
	}

	/**
	 * Calculate torrent health based on seeders/leechers
	 */
	calculateHealth(seeders: number, leechers: number): TorrentHealth {
		// Dead torrent
		if (seeders === 0) {
			return {
				score: 0,
				level: 'dead',
				description: 'No seeders - torrent may be unavailable'
			};
		}

		// Calculate ratio and level
		const ratio = leechers > 0 ? seeders / leechers : seeders;

		let level: TorrentHealth['level'];
		let score: number;
		let description: string;

		if (seeders >= HEALTH_THRESHOLDS.excellent) {
			level = 'excellent';
			score = Math.min(100, 80 + Math.floor(seeders / 10));
			description = `Excellent availability (${seeders} seeders)`;
		} else if (seeders >= HEALTH_THRESHOLDS.good) {
			level = 'good';
			score = 60 + Math.floor((seeders - HEALTH_THRESHOLDS.good) / 2);
			description = `Good availability (${seeders} seeders)`;
		} else if (seeders >= HEALTH_THRESHOLDS.fair) {
			level = 'fair';
			score = 40 + Math.floor((seeders - HEALTH_THRESHOLDS.fair) * 2);
			description = `Fair availability (${seeders} seeders)`;
		} else {
			level = 'poor';
			score = Math.max(10, seeders * 10);
			description = `Poor availability (${seeders} seeders) - download may be slow`;
		}

		// Adjust based on ratio
		if (ratio < 0.5) {
			score = Math.max(10, score - 10);
			description += ' - high demand';
		} else if (ratio > 5) {
			score = Math.min(100, score + 5);
		}

		return { score, level, description };
	}

	/**
	 * Check if torrent is freeleech
	 */
	isFreeleech(result: ReleaseResult): boolean {
		// Check torrent-specific field
		if (result.torrent?.isFreeleech) {
			return true;
		}

		// Check download factor (0 = freeleech)
		if (result.torrent?.downloadFactor === 0) {
			return true;
		}

		// Check title for freeleech indicators
		const title = result.title.toLowerCase();
		if (
			title.includes('freeleech') ||
			title.includes('[fl]') ||
			title.includes('(fl)') ||
			title.includes('free leech')
		) {
			return true;
		}

		return false;
	}

	/**
	 * Get badge class based on health level
	 */
	private getHealthBadgeClass(level: TorrentHealth['level']): string {
		switch (level) {
			case 'excellent':
				return 'badge-success';
			case 'good':
				return 'badge-info';
			case 'fair':
				return 'badge-warning';
			case 'poor':
				return 'badge-error';
			case 'dead':
				return 'badge-ghost';
		}
	}
}

/**
 * Singleton instance
 */
let instance: TorrentProtocolHandler | null = null;

export function getTorrentHandler(): TorrentProtocolHandler {
	if (!instance) {
		instance = new TorrentProtocolHandler();
	}
	return instance;
}
