import { describe, it, expect } from 'vitest';
import { MUSIC_PROFILE_OPTIONS, MUSIC_PROFILES, isMusicProfileId, resolveMusicProfile } from './profiles.js';
import { DEFAULT_MUSIC_PROFILE } from './parse-release.js';

describe('music profiles', () => {
	it('resolves null and unknown ids to the default', () => {
		expect(resolveMusicProfile(null).id).toBe(DEFAULT_MUSIC_PROFILE.id);
		expect(resolveMusicProfile('nope').id).toBe(DEFAULT_MUSIC_PROFILE.id);
	});

	it('offers the default first and exposes every profile', () => {
		expect(MUSIC_PROFILE_OPTIONS[0].id).toBe(DEFAULT_MUSIC_PROFILE.id);
		expect(MUSIC_PROFILE_OPTIONS).toHaveLength(MUSIC_PROFILES.length);
	});

	it('puts lossy first only in the lossy profile', () => {
		const lossy = resolveMusicProfile('music-lossy');
		const lossless = resolveMusicProfile('music-default');

		expect(lossy.tiers[0].label).toBe('High-bitrate lossy');
		expect(lossless.tiers[0].label).toBe('Lossless 24-bit');
	});

	it('accepts known ids and rejects invented ones', () => {
		expect(isMusicProfileId('music-any')).toBe(true);
		expect(isMusicProfileId('music-nope')).toBe(false);
	});
});
