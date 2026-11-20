/**
 * The music quality profiles a user can choose per album.
 *
 * They are code-defined, like the built-in video profiles: the ladder is the
 * policy, and a stored row only holds the id. `albums.quality_profile_id` is
 * null for "use the default", so an install that never picks one behaves
 * exactly as it did before the column existed.
 */
import { DEFAULT_MUSIC_PROFILE, type MusicQualityProfile } from './parse-release.js';

const FORMAT_SCORES = { ...DEFAULT_MUSIC_PROFILE.formatScores };

export interface MusicProfileDefinition extends MusicQualityProfile {
	description: string;
}

export const MUSIC_PROFILES: MusicProfileDefinition[] = [
	{
		...DEFAULT_MUSIC_PROFILE,
		description: 'Hi-res first, then any lossless, then high-bitrate lossy.'
	},
	{
		id: 'music-lossy',
		name: 'Lossy first',
		description: '256+ kbps MP3/AAC first; lossless only as a fallback.',
		allowFallback: true,
		tiers: [
			{ label: 'High-bitrate lossy', formats: ['mp3', 'aac'], lossless: false, minBitrateKbps: 256 },
			{ label: 'Lossy', formats: ['mp3', 'aac', 'ogg', 'opus'], lossless: false },
			{ label: 'Lossless fallback', lossless: true }
		],
		formatScores: FORMAT_SCORES
	},
	{
		id: 'music-any',
		name: 'Anything with a codec',
		description: 'Accepts any release whose format can be identified.',
		allowFallback: true,
		tiers: [
			{ label: 'Lossless', lossless: true },
			{ label: 'Lossy', formats: ['mp3', 'aac', 'ogg', 'opus'], lossless: false }
		],
		formatScores: FORMAT_SCORES
	}
];

export const MUSIC_PROFILE_OPTIONS = MUSIC_PROFILES.map((profile) => ({
	id: profile.id,
	name: profile.name,
	description: profile.description
}));

export function isMusicProfileId(id: string): boolean {
	return MUSIC_PROFILES.some((profile) => profile.id === id);
}

/** An unknown or null id is the default, never an error at read time. */
export function resolveMusicProfile(id: string | null | undefined): MusicQualityProfile {
	return MUSIC_PROFILES.find((profile) => profile.id === id) ?? DEFAULT_MUSIC_PROFILE;
}
