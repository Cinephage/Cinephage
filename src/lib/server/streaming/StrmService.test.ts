import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRootFolderWritable } from '#lib/server/filesystem/writable-guard.js';

import { StrmService } from './StrmService';

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			movies: {
				findFirst: vi.fn(async () => ({
					id: 'movie-1',
					tmdbId: 13824,
					title: 'Superstar',
					year: 1999,
					path: null,
					rootFolderId: 'root-1'
				}))
			},
			rootFolders: {
				findFirst: vi.fn(async () => ({
					id: 'root-1',
					path: '/tmp/strm-test-root',
					readOnly: false
				}))
			}
		}
	}
}));

vi.mock('#lib/server/filesystem/writable-guard.js', () => ({
	isRootFolderWritable: vi.fn()
}));

vi.mock('#lib/server/filesystem/mkdir-helpers.js', () => ({
	ensureMediaDirectory: vi.fn(async (dir: string) => {
		const { mkdirSync } = await import('node:fs');
		mkdirSync(dir, { recursive: true });
	}),
	applyMediaFileMode: vi.fn()
}));

describe('StrmService', () => {
	const service = StrmService.getInstance();

	describe('parseStrmFileUrl', () => {
		it('parses movie URLs with api_key query params', () => {
			expect(
				service.parseStrmFileUrl(
					'https://media.example.com/api/streaming/session/movie/603?api_key=old-key'
				)
			).toEqual({
				mediaType: 'movie',
				tmdbId: '603'
			});
		});

		it('parses tv URLs with query params', () => {
			expect(
				service.parseStrmFileUrl(
					'https://media.example.com/api/streaming/session/tv/1399/1/1?api_key=old-key&prefetch=1'
				)
			).toEqual({
				mediaType: 'tv',
				tmdbId: '1399',
				season: 1,
				episode: 1
			});
		});

		it('parses path-only URLs without query params', () => {
			expect(service.parseStrmFileUrl('/api/streaming/session/movie/550')).toEqual({
				mediaType: 'movie',
				tmdbId: '550'
			});
		});

		it('still parses legacy master.m3u8 movie URLs', () => {
			expect(
				service.parseStrmFileUrl(
					'https://media.example.com/api/streaming/session/movie/603/master.m3u8?api_key=old-key'
				)
			).toEqual({
				mediaType: 'movie',
				tmdbId: '603'
			});
		});

		it('still parses legacy master.m3u8 tv URLs', () => {
			expect(
				service.parseStrmFileUrl(
					'https://media.example.com/api/streaming/session/tv/1399/1/1/master.m3u8?api_key=old-key&prefetch=1'
				)
			).toEqual({
				mediaType: 'tv',
				tmdbId: '1399',
				season: 1,
				episode: 1
			});
		});

		it('rejects unrelated URLs', () => {
			expect(service.parseStrmFileUrl('https://nzb.example.com/random/file')).toBeNull();
		});
	});

	describe('generateStrmContent', () => {
		it('regenerates movie URLs with the currently active API key', async () => {
			const parsed = service.parseStrmFileUrl(
				'https://old.example.com/api/streaming/session/movie/603?api_key=stale-key'
			);

			expect(parsed).toEqual({
				mediaType: 'movie',
				tmdbId: '603'
			});

			const updatedContent = await service.generateStrmContent({
				mediaType: parsed!.mediaType,
				tmdbId: parsed!.tmdbId,
				baseUrl: 'https://new.example.com',
				apiKey: 'active-key'
			});

			expect(updatedContent).toBe(
				'https://new.example.com/api/streaming/session/movie/603?api_key=active-key'
			);
			expect(updatedContent).not.toContain('stale-key');
			expect(updatedContent).not.toContain('master.m3u8');
		});

		it('regenerates tv URLs with the currently active API key', async () => {
			const parsed = service.parseStrmFileUrl(
				'https://old.example.com/api/streaming/session/tv/1399/1/2?api_key=stale-key'
			);

			expect(parsed).toEqual({
				mediaType: 'tv',
				tmdbId: '1399',
				season: 1,
				episode: 2
			});

			const updatedContent = await service.generateStrmContent({
				mediaType: parsed!.mediaType,
				tmdbId: parsed!.tmdbId,
				season: parsed!.season,
				episode: parsed!.episode,
				baseUrl: 'https://new.example.com',
				apiKey: 'active-key'
			});

			expect(updatedContent).toBe(
				'https://new.example.com/api/streaming/session/tv/1399/1/2?api_key=active-key'
			);
			expect(updatedContent).not.toContain('stale-key');
			expect(updatedContent).not.toContain('master.m3u8');
		});

		it('migrates legacy master.m3u8 URLs to the bare format on bulk regeneration', async () => {
			const parsed = service.parseStrmFileUrl(
				'https://old.example.com/api/streaming/session/movie/603/master.m3u8?api_key=stale-key'
			);
			expect(parsed).toEqual({ mediaType: 'movie', tmdbId: '603' });

			const updatedContent = await service.generateStrmContent({
				mediaType: parsed!.mediaType,
				tmdbId: parsed!.tmdbId,
				baseUrl: 'https://new.example.com',
				apiKey: 'active-key'
			});

			expect(updatedContent).toBe(
				'https://new.example.com/api/streaming/session/movie/603?api_key=active-key'
			);
		});
	});

	describe('naming-based path generation', () => {
		it('uses the current naming service for movie strm paths', async () => {
			(
				service as unknown as {
					getNamingService: () => {
						generateMovieFolderName: () => string;
						generateMovieFileName: () => string;
					};
				}
			).getNamingService = () => ({
				generateMovieFolderName: () => 'Movie Folder',
				generateMovieFileName: () => 'Movie File.strm'
			});

			expect(
				await (
					service as unknown as {
						buildMovieStrmPath: (
							rootFolderPath: string,
							movie: {
								title: string;
								year: number | null;
								tmdbId: number;
								imdbId?: string | null;
								path: string | null;
							}
						) => Promise<string>;
					}
				).buildMovieStrmPath('/library/movies', {
					title: 'Movie',
					year: 2024,
					tmdbId: 1,
					path: null
				})
			).toBe(join('/library/movies', 'Movie Folder', 'Movie File.strm'));
		});

		it('uses the current naming service for episode strm paths', async () => {
			(
				service as unknown as {
					getNamingService: () => {
						generateSeriesFolderName: () => string;
						generateSeasonFolderName: () => string;
						generateEpisodeFileName: () => string;
					};
				}
			).getNamingService = () => ({
				generateSeriesFolderName: () => 'Series Folder',
				generateSeasonFolderName: () => 'Collection 03',
				generateEpisodeFileName: () => 'Episode 08.strm'
			});

			expect(
				await (
					service as unknown as {
						buildEpisodeStrmPath: (
							rootFolderPath: string,
							show: {
								title: string;
								year: number | null;
								tmdbId: number;
								tvdbId?: number | null;
								path: string | null;
								seasonFolder?: boolean | null;
							},
							seasonNumber: number,
							episodeNumber: number,
							episodeTitle?: string | null
						) => Promise<string>;
					}
				).buildEpisodeStrmPath(
					'/library/tv',
					{
						title: 'Show',
						year: 2024,
						tmdbId: 2,
						path: null,
						seasonFolder: true
					},
					3,
					8,
					'Test Episode'
				)
			).toBe(join('/library/tv', 'Series Folder', 'Collection 03', 'Episode 08.strm'));
		});
	});

	describe('createStrmFile read-only guard', () => {
		let tmpRoot: string;

		afterEach(() => {
			if (tmpRoot) {
				rmSync(tmpRoot, { recursive: true, force: true });
				tmpRoot = '';
			}
			vi.mocked(isRootFolderWritable).mockReset();
		});

		function stubNamingService() {
			(
				service as unknown as {
					getNamingService: () => {
						generateMovieFolderName: () => string;
						generateMovieFileName: () => string;
					};
				}
			).getNamingService = () => ({
				generateMovieFolderName: () => 'Movie Folder',
				generateMovieFileName: () => 'Movie File.strm'
			});
		}

		it('writes movie .strm files into a writable root using the resolved root folder id', async () => {
			tmpRoot = mkdtempSync(join(tmpdir(), 'strm-test-'));
			stubNamingService();

			const { db } = await import('#lib/server/db/index.js');
			const writableRoot = { id: 'root-1', path: tmpRoot, readOnly: false } as Awaited<
				ReturnType<typeof db.query.rootFolders.findFirst>
			>;
			vi.mocked(db.query.rootFolders.findFirst).mockResolvedValue(writableRoot);
			vi.mocked(isRootFolderWritable).mockResolvedValue(true);

			const result = await service.createStrmFile({
				mediaType: 'movie',
				tmdbId: '13824',
				movieId: 'movie-1',
				baseUrl: 'https://new.example.com',
				apiKey: 'active-key'
			});

			expect(result.success).toBe(true);
			// Regression: the movie branch must resolve the root folder id, or the
			// guard rejects every movie grab as "read-only".
			expect(isRootFolderWritable).toHaveBeenCalledWith('root-1');

			const written = join(tmpRoot, 'Movie Folder', 'Movie File.strm');
			expect(existsSync(written)).toBe(true);
			expect(readFileSync(written, 'utf8')).toBe(
				'https://new.example.com/api/streaming/session/movie/13824?api_key=active-key'
			);
		});

		it('still rejects movie .strm writes when the root folder is read-only', async () => {
			tmpRoot = mkdtempSync(join(tmpdir(), 'strm-test-'));
			stubNamingService();

			const { db } = await import('#lib/server/db/index.js');
			const readOnlyRoot = { id: 'root-1', path: tmpRoot, readOnly: true } as Awaited<
				ReturnType<typeof db.query.rootFolders.findFirst>
			>;
			vi.mocked(db.query.rootFolders.findFirst).mockResolvedValue(readOnlyRoot);
			vi.mocked(isRootFolderWritable).mockResolvedValue(false);

			const result = await service.createStrmFile({
				mediaType: 'movie',
				tmdbId: '13824',
				movieId: 'movie-1',
				baseUrl: 'https://new.example.com',
				apiKey: 'active-key'
			});

			expect(result).toEqual({
				success: false,
				error: 'Cannot write .strm placeholder into a read-only root folder'
			});
			expect(existsSync(join(tmpRoot, 'Movie Folder'))).toBe(false);
		});
	});
});
