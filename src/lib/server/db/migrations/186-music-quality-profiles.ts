import type { MigrationDefinition } from '../migration-helpers.js';

/**
 * Version 186: music quality uses the profile system that already exists.
 *
 * `scoring_profiles` gains `media_kind` ('video' rows keep their historical
 * behaviour) and `music_tiers` (the ordered ladder). The four built-in music
 * profiles are rows in that same table — no parallel profile store, and the
 * Settings → Quality page is the one place they are managed.
 *
 * `artists.quality_profile_id` is added here; `albums.quality_profile_id`
 * arrived in 185. The default music profile is a settings value, so it never
 * collides with the single video default flag.
 */
const BUILT_INS = [
	{
		id: 'music-default',
		name: 'Lossless first',
		description: 'Lossless torrents first, then high-bitrate lossy, then streaming.',
		tiers: [
			{ kind: 'lossless', label: 'Lossless' },
			{ kind: 'lossy', label: 'High-bitrate lossy', formats: ['mp3', 'aac'], minBitrateKbps: 256 },
			{ kind: 'lossy', label: 'Lossy', formats: ['mp3', 'aac', 'ogg', 'opus'] },
			{ kind: 'streaming', label: 'Streaming' }
		],
		protocols: ['torrent', 'usenet', 'streaming']
	},
	{
		id: 'music-flac',
		name: 'FLAC only',
		description: 'Only lossless torrents. No streaming, no lossy fallback.',
		tiers: [{ kind: 'lossless', label: 'FLAC', formats: ['flac'] }],
		protocols: ['torrent', 'usenet']
	},
	{
		id: 'music-lossy',
		name: 'Lossy first',
		description: '256+ kbps MP3/AAC first, then lossless, then streaming.',
		tiers: [
			{ kind: 'lossy', label: 'High-bitrate lossy', formats: ['mp3', 'aac'], minBitrateKbps: 256 },
			{ kind: 'lossy', label: 'Lossy', formats: ['mp3', 'aac', 'ogg', 'opus'] },
			{ kind: 'lossless', label: 'Lossless fallback' },
			{ kind: 'streaming', label: 'Streaming' }
		],
		protocols: ['torrent', 'usenet', 'streaming']
	},
	{
		id: 'music-streaming',
		name: 'Streaming only',
		description: 'Never download audio: every album streams through the Streamer.',
		tiers: [{ kind: 'streaming', label: 'Streaming' }],
		protocols: ['streaming']
	}
];

function hasColumn(
	sqlite: Parameters<MigrationDefinition['apply']>[0],
	table: string,
	column: string
) {
	const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
	return columns.some((entry) => entry.name === column);
}

export const migration_v186: MigrationDefinition = {
	version: 186,
	name: 'music_quality_profiles',
	apply: (sqlite) => {
		if (!hasColumn(sqlite, 'scoring_profiles', 'media_kind')) {
			sqlite
				.prepare(`ALTER TABLE "scoring_profiles" ADD COLUMN "media_kind" text DEFAULT 'video'`)
				.run();
		}
		if (!hasColumn(sqlite, 'scoring_profiles', 'music_tiers')) {
			sqlite.prepare(`ALTER TABLE "scoring_profiles" ADD COLUMN "music_tiers" text`).run();
		}
		if (!hasColumn(sqlite, 'artists', 'quality_profile_id')) {
			sqlite.prepare(`ALTER TABLE "artists" ADD COLUMN "quality_profile_id" text`).run();
		}

		const insert = sqlite.prepare(
			`INSERT OR IGNORE INTO "scoring_profiles"
			 ("id","name","description","media_kind","music_tiers","is_built_in","is_default","allowed_protocols","created_at","updated_at")
			 VALUES (?,?,?,'music',?,1,0,?,?,?)`
		);
		const now = new Date().toISOString();

		for (const profile of BUILT_INS) {
			insert.run(
				profile.id,
				profile.name,
				profile.description,
				JSON.stringify(profile.tiers),
				JSON.stringify(profile.protocols),
				now,
				now
			);
		}

		sqlite
			.prepare(`INSERT OR IGNORE INTO "settings" ("key","value") VALUES ('music_quality', ?)`)
			.run(JSON.stringify({ defaultProfileId: 'music-default' }));
	}
};
