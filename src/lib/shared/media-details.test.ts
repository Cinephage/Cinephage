import { describe, expect, it } from 'vitest';
import {
	animeProviderRows,
	hasAnimeProviderLink,
	mediaStoragePath,
	type ProviderVisibility
} from './media-details.js';

const bothOn: ProviderVisibility = { anilist: true, mal: true };
const noneOn: ProviderVisibility = { anilist: false, mal: false };

describe('mediaStoragePath', () => {
	it('joins the root folder and the stored relative path', () => {
		expect(mediaStoragePath('/media/Movies', 'Dune (2021)')).toBe('/media/Movies/Dune (2021)');
	});

	it('does not double the separator when either side carries one', () => {
		expect(mediaStoragePath('/media/Movies/', '/Dune (2021)')).toBe('/media/Movies/Dune (2021)');
	});

	it('falls back to whichever side exists', () => {
		expect(mediaStoragePath(null, 'Dune (2021)')).toBe('Dune (2021)');
		expect(mediaStoragePath('/media/Movies', null)).toBe('/media/Movies');
		expect(mediaStoragePath(null, null)).toBe('');
	});
});

describe('hasAnimeProviderLink', () => {
	it('is true when either provider id is present', () => {
		expect(hasAnimeProviderLink({ providerRefs: { anilist: '42' } })).toBe(true);
		expect(hasAnimeProviderLink({ providerRefs: { mal: '7' } })).toBe(true);
		expect(hasAnimeProviderLink({ providerRefs: { anilist: null, mal: null } })).toBe(false);
	});
});

describe('animeProviderRows', () => {
	it('renders nothing for a non-anime item', () => {
		expect(animeProviderRows({ rootFolderPath: '/media/Movies' }, bothOn)).toEqual([]);
	});

	it('treats an /anime/ root folder as anime even without ids', () => {
		const rows = animeProviderRows({ rootFolderPath: '/media/Anime/Movies' }, bothOn);
		expect(rows.map((row) => [row.label, row.value, row.resolved])).toEqual([
			['AniList', 'N/A', false],
			['MAL', 'N/A', false]
		]);
	});

	it('links the ids it has and marks the missing ones N/A', () => {
		const rows = animeProviderRows(
			{ rootFolderPath: '/media/Anime', providerRefs: { anilist: '42' } },
			bothOn
		);
		expect(rows[0]).toEqual({
			label: 'AniList',
			value: '42',
			resolved: true,
			href: 'https://anilist.co/anime/42',
			provider: 'anilist'
		});
		expect(rows[1]).toEqual({
			label: 'MAL',
			value: 'N/A',
			resolved: false,
			provider: 'mal'
		});
	});

	it('only includes configured providers', () => {
		const rows = animeProviderRows(
			{ rootFolderPath: '/media/Anime', providerRefs: { anilist: '42', mal: '7' } },
			{ anilist: true, mal: false }
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].provider).toBe('anilist');
	});

	it('renders nothing when no provider is configured', () => {
		expect(
			animeProviderRows({ rootFolderPath: '/media/Anime', providerRefs: { mal: '7' } }, noneOn)
		).toEqual([]);
	});
});
