import { describe, expect, it } from 'vitest';
import { cleanChannel, parseYoutubeEntry, stripUploadNoise, youtubeSource } from './youtube.js';

describe('stripUploadNoise', () => {
	it('drops upload noise but keeps a version that changes the recording', () => {
		expect(stripUploadNoise('One More Time (Official Video)')).toBe('One More Time');
		expect(stripUploadNoise('Get Lucky [HD]')).toBe('Get Lucky');
		expect(stripUploadNoise('Hey Jude (Remastered 2015)')).toBe('Hey Jude (Remastered 2015)');
		expect(stripUploadNoise('Wonderwall (Live at Knebworth)')).toBe(
			'Wonderwall (Live at Knebworth)'
		);
	});

	it('drops a bare trailing noise word', () => {
		expect(stripUploadNoise('Around the World Official Video')).toBe('Around the World');
	});
});

describe('parseYoutubeEntry', () => {
	it('reads Artist - Title and ignores the channel', () => {
		const track = parseYoutubeEntry('Daft Punk - One More Time (Official Video)', 'Daft Punk');
		expect(track.title).toBe('One More Time');
		expect(track.artists).toEqual(['Daft Punk']);
	});

	it('reads the reversed Title - Artist order when the channel names the artist side', () => {
		const track = parseYoutubeEntry('BELLAKEO (Video Oficial) - Peso Pluma, Anitta', 'Peso Pluma');
		expect(track.title).toBe('BELLAKEO');
		expect(track.artists).toEqual(['Peso Pluma', 'Anitta']);
	});

	it('falls back to the channel when the title has no separator', () => {
		const track = parseYoutubeEntry('Bohemian Rhapsody (Official Video)', 'Queen Official');
		expect(track.title).toBe('Bohemian Rhapsody');
		expect(track.artists).toEqual(['Queen']);
	});

	it('leaves a title with no artist anywhere unresolved instead of inventing one', () => {
		const track = parseYoutubeEntry('lofi hip hop radio', null);
		expect(track.title).toBe('lofi hip hop radio');
		expect(track.artists).toEqual([]);
	});
});

describe('cleanChannel', () => {
	it('strips the suffixes YouTube adds for music uploads', () => {
		expect(cleanChannel('Daft Punk - Topic')).toBe('Daft Punk');
		expect(cleanChannel('TaylorSwiftVEVO')).toBe('TaylorSwift');
		expect(cleanChannel('Queen Official')).toBe('Queen');
		expect(cleanChannel(null)).toBeNull();
	});
});

describe('youtubeSource.parseUrl', () => {
	it('accepts the three playlist URL shapes', () => {
		expect(
			youtubeSource.parseUrl(new URL('https://www.youtube.com/playlist?list=PLabc123456789'))
		).toBe('PLabc123456789');
		expect(
			youtubeSource.parseUrl(new URL('https://music.youtube.com/playlist?list=OLAK5uy_abc'))
		).toBe('OLAK5uy_abc');
		expect(youtubeSource.parseUrl(new URL('https://youtu.be/vid123?list=PLxyz123456789'))).toBe(
			'PLxyz123456789'
		);
	});

	it('refuses a video URL with no playlist and a non-YouTube host', () => {
		expect(youtubeSource.parseUrl(new URL('https://www.youtube.com/watch?v=abc'))).toBeNull();
		expect(youtubeSource.parseUrl(new URL('https://open.spotify.com/playlist/abc'))).toBeNull();
	});
});
