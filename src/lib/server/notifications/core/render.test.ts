import { describe, expect, it } from 'vitest';
import { renderNotification, renderTestNotification, eventLabel, eventColor } from './render.js';

describe('renderNotification', () => {
	it('titles an import with the media title and year', () => {
		const message = renderNotification({
			event: 'import',
			media: { type: 'movie', title: 'Dune: Part Two', year: 2024 },
			quality: '2160p WEB-DL',
			releaseName: 'Dune.Part.Two.2024.2160p.WEB-DL',
			summary: 'Movie imported into the library'
		});

		expect(message.title).toBe('Imported: Dune: Part Two (2024)');
		expect(message.body).toBe('Movie imported into the library');
		expect(message.fields).toEqual(
			expect.arrayContaining([
				{ name: 'Media', value: 'Dune: Part Two (2024)' },
				{ name: 'Quality', value: '2160p WEB-DL' },
				{ name: 'Release', value: 'Dune.Part.Two.2024.2160p.WEB-DL' }
			])
		);
	});

	it('compresses a long episode list instead of listing every episode', () => {
		const episodes = Array.from({ length: 8 }, (_, index) => ({
			seasonNumber: 2,
			episodeNumber: index + 1,
			title: `Episode ${index + 1}`
		}));
		const message = renderNotification({
			event: 'import',
			media: { type: 'series', title: 'Severance' },
			episodes
		});

		expect(message.fields).toEqual(
			expect.arrayContaining([{ name: 'Episodes', value: 'S02E01 – S02E08 (8 episodes)' }])
		);
	});

	it('lists a short episode set individually', () => {
		const message = renderNotification({
			event: 'grab',
			media: { type: 'series', title: 'Severance' },
			episodes: [
				{ seasonNumber: 1, episodeNumber: 2, title: 'Half Loop' },
				{ seasonNumber: 1, episodeNumber: 3 }
			]
		});

		expect(message.fields).toEqual(
			expect.arrayContaining([{ name: 'Episodes', value: 'S01E02 Half Loop, S01E03' }])
		);
	});

	it('falls back to an event label when no subject is known', () => {
		const message = renderNotification({ event: 'request_pending' });
		expect(message.title).toBe('New request');
		expect(message.body.length).toBeGreaterThan(0);
	});

	it('gives declining and failing events the error colour', () => {
		expect(eventColor('request_declined')).toBe(eventColor('request_failed'));
		expect(eventColor('import')).not.toBe(eventColor('request_failed'));
		expect(eventLabel('request_available')).toBe('Request available');
	});

	it('builds a canned test message', () => {
		const message = renderTestNotification();
		expect(message.event).toBe('test');
		expect(message.title).toBe('Cinephage test notification');
		expect(message.body).toContain('test notification');
	});
});

describe('task failure rendering', () => {
	it('titles a failed task with its label and carries the error', () => {
		const message = renderNotification({
			event: 'task_failed',
			task: { name: 'Missing Content Search', error: 'indexer timeout' }
		});

		expect(message.title).toBe('Task failed: Missing Content Search');
		expect(message.body).toContain('indexer timeout');
		expect(message.fields).toEqual(
			expect.arrayContaining([{ name: 'Error', value: 'indexer timeout' }])
		);
	});

	it('carries a poster into imageUrl', () => {
		const message = renderNotification({
			event: 'import',
			media: { type: 'movie', title: 'Dune', posterUrl: 'https://image.tmdb.org/t/p/w500/x.jpg' }
		});
		expect(message.imageUrl).toBe('https://image.tmdb.org/t/p/w500/x.jpg');
	});
});
