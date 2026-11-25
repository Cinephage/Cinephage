import { describe, expect, it, vi } from 'vitest';
import { createDeezerChartSource, musicLegacyRows } from './deezer.js';
import { catalogSourceForKind } from './registry.js';

const album = (id: number, title: string, artist: string) => ({
	id,
	title,
	cover_big: `https://x/${id}.jpg`,
	artist: { name: artist }
});

const deezerPage = (rows: unknown[]) =>
	new Response(JSON.stringify({ data: rows, total: 9999 }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

describe('deezer chart source', () => {
	it('is the registered source for music', () => {
		expect(catalogSourceForKind('music')?.id).toBe('deezer');
	});

	it('serves music rows from the chart and maps them to the discover shape', async () => {
		const fetchImpl = vi.fn(async () => deezerPage([album(1, 'Discovery', 'Daft Punk')]));
		const clock = 1_000;
		const source = createDeezerChartSource({ fetchImpl, now: () => clock });

		const result = await source.discover({ page: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result?.items).toHaveLength(1);
		const item = result!.items[0];
		expect(item.kind).toBe('music');
		expect(item.id).toBe('1');
		expect(item.title).toBe('Discovery');
		expect(item.subtitle).toBe('Daft Punk');
		expect(item.imageUrl).toContain('x/1.jpg');

		const [row] = musicLegacyRows(result!.items);
		expect(row.id).toBe('1');
		expect(row.title).toBe('Discovery');
		expect(row.subtitle).toBe('Daft Punk');
		expect(row.image_url).toContain('x/1.jpg');
		expect(row.media_type).toBe('music');
	});

	it('pages within one chart snapshot and reports its total', async () => {
		const rows = Array.from({ length: 30 }, (_, i) => album(i + 1, `Album ${i + 1}`, `A${i}`));
		const fetchImpl = vi.fn(async () => deezerPage(rows));
		const source = createDeezerChartSource({ fetchImpl, now: () => 1 });

		const page1 = await source.discover({ page: 1 });
		const page2 = await source.discover({ page: 2 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(page1?.items).toHaveLength(24);
		expect(page2?.items).toHaveLength(6);
		expect(page1?.pagination.total_results).toBe(9999);
		expect(page1?.pagination.total_pages).toBeGreaterThanOrEqual(2);
	});

	it('reuses the cached chart inside the TTL window and refetches after it', async () => {
		let clock = 1_000;
		const fetchImpl = vi.fn(async () => deezerPage([album(1, 'One', 'A')]));
		const source = createDeezerChartSource({ fetchImpl, now: () => clock });

		await source.discover({ page: 1 });
		await source.discover({ page: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock += 60 * 60 * 1000 + 1;
		await source.discover({ page: 1 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('returns null before the first successful fetch, and keeps the last page when the upstream dies', async () => {
		const failing = vi.fn(async () => new Response('nope', { status: 503 }));
		const cold = createDeezerChartSource({ fetchImpl: failing, now: () => 1 });
		expect(await cold.discover({ page: 1 })).toBeNull();

		let ok = true;
		const fetchImpl = vi.fn(async () =>
			ok ? deezerPage([album(1, 'One', 'A')]) : new Response('x', { status: 500 })
		);
		const source = createDeezerChartSource({ fetchImpl, now: () => 1 });
		expect((await source.discover({ page: 1 }))?.items).toHaveLength(1);
		ok = false;
		const stale = await source.discover({ page: 1 });
		expect(stale?.items).toHaveLength(1);
	});
});
