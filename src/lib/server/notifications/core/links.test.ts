/**
 * Deep links: a notification is only worth a URL when the instance knows its
 * own public address, and the settings read is mocked at the module boundary.
 */

import { describe, it, expect, vi } from 'vitest';

let externalUrl: string | null = null;

vi.mock('#lib/server/settings/SystemSettingsService.js', () => ({
	getSystemSettingsService: () => ({
		getExternalUrl: async () => externalUrl
	})
}));

const { buildLink, getPublicBaseUrl, libraryPath, tmdbPosterUrl } = await import('./links.js');

describe('notification links', () => {
	it('builds absolute links from the configured external URL', async () => {
		externalUrl = 'https://cine.example/';
		expect(await getPublicBaseUrl()).toBe('https://cine.example');
		expect(await buildLink('/requests')).toBe('https://cine.example/requests');
	});

	it('produces no link when no public URL is configured', async () => {
		externalUrl = null;
		expect(await getPublicBaseUrl()).toBeNull();
		expect(await buildLink('/library/movie/abc')).toBeNull();
	});

	it('refuses a value that is not an http(s) URL', async () => {
		externalUrl = 'cine.local:3000';
		expect(await getPublicBaseUrl()).toBeNull();
	});

	it('maps entity types to their app routes', () => {
		expect(libraryPath('movie', 'abc')).toBe('/library/movie/abc');
		expect(libraryPath('series', 'xyz')).toBe('/library/tv/xyz');
		expect(libraryPath('album', 'alb')).toBe('/library/music/alb');
	});

	it('turns a TMDB poster path into an absolute image URL', () => {
		expect(tmdbPosterUrl('/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg')).toBe(
			'https://image.tmdb.org/t/p/w500/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg'
		);
		expect(tmdbPosterUrl('dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg')).toBe(
			'https://image.tmdb.org/t/p/w500/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg'
		);
		expect(tmdbPosterUrl(null)).toBeNull();
	});
});
