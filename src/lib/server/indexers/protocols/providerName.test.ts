import { describe, expect, it } from 'vitest';
import { providerFamily, providerMatches } from './providerName.js';

describe('providerFamily', () => {
	it('drops the gateway sub-source suffix and lowercases', () => {
		expect(providerFamily('Cno (2160p)')).toBe('cno');
		expect(providerFamily('Vidy (1080p)')).toBe('vidy');
		expect(providerFamily('Vidlove (MovieBox2)')).toBe('vidlove');
		expect(providerFamily('Cinemabz (cookiebakers)')).toBe('cinemabz');
		expect(providerFamily('Vidlink')).toBe('vidlink');
	});

	it('returns an empty string for missing input', () => {
		expect(providerFamily(undefined)).toBe('');
		expect(providerFamily(null)).toBe('');
		expect(providerFamily('   ')).toBe('');
	});
});

describe('providerMatches', () => {
	it('matches a base prefix against every rendition suffix', () => {
		for (const quality of ['2160p', '1080p', '720p', '480p']) {
			expect(providerMatches(`Cno (${quality})`, 'cno')).toBe(true);
			expect(providerMatches(`Vidy (${quality})`, 'Vidy')).toBe(true);
		}
		expect(providerMatches('Vidlove (MovieBox)', 'vidlove')).toBe(true);
		expect(providerMatches('Vidlove (VidAPI)', 'vidlove')).toBe(true);
		expect(providerMatches('Vidlove (MovieBox2)', 'vidlove')).toBe(true);
		expect(providerMatches('Cinemabz (cookiebakers)', 'cinemabz')).toBe(true);
		expect(providerMatches('Vidlink', 'vidlink')).toBe(true);
	});

	it('matches a configured label against a provider from another rendition', () => {
		expect(providerMatches('Cno (2160p)', 'Cno (1080p)')).toBe(true);
		expect(providerMatches('Vidy (720p)', 'vidy')).toBe(true);
	});

	it('does not match different providers', () => {
		expect(providerMatches('Cno (2160p)', 'vidy')).toBe(false);
		expect(providerMatches('Vidy (1080p)', 'vidlove')).toBe(false);
		expect(providerMatches('Vidlove (MovieBox)', 'vidlink')).toBe(false);
	});

	it('does not match when either side is empty', () => {
		expect(providerMatches(undefined, 'cno')).toBe(false);
		expect(providerMatches('Cno (2160p)', undefined)).toBe(false);
		expect(providerMatches('Cno (2160p)', '')).toBe(false);
	});
});
