import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm, truncate, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImportService } from './ImportService';

async function createTempDir() {
	return mkdtemp(join(tmpdir(), 'cinephage-import-'));
}

async function createSizedFile(filePath: string, sizeBytes: number) {
	await writeFile(filePath, '');
	await truncate(filePath, sizeBytes);
}

describe('ImportService SAB mount-mode STRM selection', () => {
	beforeEach(() => {
		ImportService.resetInstance();
	});

	it('prefers non-strm when present for mount-mode options', async () => {
		const dir = await createTempDir();
		try {
			const strmPath = join(dir, 'movie.strm');
			const mkvPath = join(dir, 'movie.mkv');

			await writeFile(strmPath, 'http://example.com/stream');
			await createSizedFile(mkvPath, 60 * 1024 * 1024);

			const service = ImportService.getInstance();
			const files = await (
				service as unknown as {
					findImportableFiles: (
						downloadPath: string,
						options: { allowStrmSmall: boolean; preferNonStrm: boolean }
					) => Promise<Array<{ path: string; size: number }>>;
				}
			).findImportableFiles(dir, { allowStrmSmall: true, preferNonStrm: true });

			expect(files).toHaveLength(1);
			expect(files[0].path).toBe(mkvPath);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('allows small strm files when configured for mount mode', async () => {
		const dir = await createTempDir();
		try {
			const strmPath = join(dir, 'movie.strm');
			await writeFile(strmPath, 'http://example.com/stream');

			const service = ImportService.getInstance();
			const files = await (
				service as unknown as {
					findImportableFiles: (
						downloadPath: string,
						options: { allowStrmSmall: boolean; preferNonStrm: boolean }
					) => Promise<Array<{ path: string; size: number }>>;
				}
			).findImportableFiles(dir, { allowStrmSmall: true, preferNonStrm: true });

			expect(files).toHaveLength(1);
			expect(files[0].path).toBe(strmPath);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('rejects small strm files by default', async () => {
		const dir = await createTempDir();
		try {
			const strmPath = join(dir, 'movie.strm');
			await writeFile(strmPath, 'http://example.com/stream');

			const service = ImportService.getInstance();
			const files = await (
				service as unknown as {
					findImportableFiles: (
						downloadPath: string,
						options: { allowStrmSmall: boolean; preferNonStrm: boolean }
					) => Promise<Array<{ path: string; size: number }>>;
				}
			).findImportableFiles(dir, { allowStrmSmall: false, preferNonStrm: false });

			expect(files).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('includes symlinked video files when scanning import candidates', async () => {
		const sourceDir = await createTempDir();
		const downloadDir = await createTempDir();
		try {
			const targetPath = join(sourceDir, 'actual-video.mkv');
			const symlinkPath = join(downloadDir, 'linked-video.mkv');
			await createSizedFile(targetPath, 60 * 1024 * 1024);
			await symlink(targetPath, symlinkPath);

			const service = ImportService.getInstance();
			const files = await (
				service as unknown as {
					findImportableFiles: (
						downloadPath: string,
						options: { allowStrmSmall: boolean; preferNonStrm: boolean }
					) => Promise<Array<{ path: string; size: number }>>;
				}
			).findImportableFiles(downloadDir, { allowStrmSmall: false, preferNonStrm: false });

			expect(files).toHaveLength(1);
			expect(files[0].path).toBe(symlinkPath);
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
			await rm(downloadDir, { recursive: true, force: true });
		}
	});

	it('allows strm import when queue path is a direct .strm file', () => {
		const service = ImportService.getInstance() as unknown as {
			getImportOptions: (
				client?: { implementation?: string },
				queueItem?: { outputPath?: string | null; clientDownloadPath?: string | null }
			) => { allowStrmSmall: boolean; preferNonStrm: boolean };
		};

		const options = service.getImportOptions(undefined, {
			outputPath: '/mnt/nzbmount/completed/movie.strm',
			clientDownloadPath: null
		});

		expect(options.allowStrmSmall).toBe(true);
		expect(options.preferNonStrm).toBe(false);
	});

	it('treats SABnzbd mount mode as STRM-capable (parity with legacy mount alias)', () => {
		const service = ImportService.getInstance() as unknown as {
			getImportOptions: (
				client?: { implementation?: string; mountMode?: string | null },
				queueItem?: { outputPath?: string | null; clientDownloadPath?: string | null }
			) => { allowStrmSmall: boolean; preferNonStrm: boolean };
		};

		const options = service.getImportOptions(
			{
				implementation: 'sabnzbd',
				mountMode: 'nzbdav'
			},
			undefined
		);

		expect(options.allowStrmSmall).toBe(true);
		expect(options.preferNonStrm).toBe(true);
	});

	it('keeps regular SABnzbd behavior unchanged when mount mode is not configured', () => {
		const service = ImportService.getInstance() as unknown as {
			getImportOptions: (
				client?: { implementation?: string; mountMode?: string | null },
				queueItem?: { outputPath?: string | null; clientDownloadPath?: string | null }
			) => { allowStrmSmall: boolean; preferNonStrm: boolean };
		};

		const options = service.getImportOptions(
			{
				implementation: 'sabnzbd',
				mountMode: null
			},
			undefined
		);

		expect(options.allowStrmSmall).toBe(false);
		expect(options.preferNonStrm).toBe(false);
	});
});

describe('ImportService queue-context episode fallback', () => {
	beforeEach(() => {
		ImportService.resetInstance();
	});

	it('maps relative season-pack episode numbers using queued episode IDs', () => {
		const service = ImportService.getInstance() as unknown as {
			matchEpisodesFromQueueContext: (
				seriesEpisodes: Array<{
					id: string;
					seriesId: string;
					seasonNumber: number;
					episodeNumber: number;
				}>,
				queueItem: { episodeIds?: string[] | null; seasonNumber?: number | null },
				identifier: {
					numbering: 'standard';
					seasonNumber: number;
					episodeNumbers: number[];
				}
			) => Array<{ id: string; episodeNumber: number }>;
		};

		const seriesEpisodes = [
			{ id: 'ep-62', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 62 },
			{ id: 'ep-63', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 63 },
			{ id: 'ep-64', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 64 },
			{ id: 'ep-65', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 65 },
			{ id: 'ep-66', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 66 },
			{ id: 'ep-67', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 67 },
			{ id: 'ep-68', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 68 },
			{ id: 'ep-69', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 69 }
		];

		const matching = service.matchEpisodesFromQueueContext(
			seriesEpisodes,
			{
				episodeIds: ['ep-62', 'ep-63', 'ep-64', 'ep-65', 'ep-66', 'ep-67', 'ep-68', 'ep-69'],
				seasonNumber: 2
			},
			{
				numbering: 'standard',
				seasonNumber: 2,
				episodeNumbers: [1, 2, 8]
			}
		);

		expect(matching.map((episode) => episode.id)).toEqual(['ep-62', 'ep-63', 'ep-69']);
	});

	it('returns no fallback matches when parsed season differs from queued season', () => {
		const service = ImportService.getInstance() as unknown as {
			matchEpisodesFromQueueContext: (
				seriesEpisodes: Array<{
					id: string;
					seriesId: string;
					seasonNumber: number;
					episodeNumber: number;
				}>,
				queueItem: { episodeIds?: string[] | null; seasonNumber?: number | null },
				identifier: {
					numbering: 'standard';
					seasonNumber: number;
					episodeNumbers: number[];
				}
			) => Array<{ id: string; episodeNumber: number }>;
		};

		const matching = service.matchEpisodesFromQueueContext(
			[{ id: 'ep-62', seriesId: 'series-1', seasonNumber: 2, episodeNumber: 62 }],
			{ episodeIds: ['ep-62'], seasonNumber: 2 },
			{ numbering: 'standard', seasonNumber: 3, episodeNumbers: [1] }
		);

		expect(matching).toHaveLength(0);
	});
});

describe('ImportService episode identifier fallback parsing', () => {
	beforeEach(() => {
		ImportService.resetInstance();
	});

	it('resolves episode from queue title when source basename is obfuscated', () => {
		const service = ImportService.getInstance() as unknown as {
			resolveEpisodeIdentifierWithFallback: (
				videoFilePath: string,
				queueItem: { title: string; seasonNumber?: number | null },
				seriesType: 'standard' | 'anime' | 'daily'
			) =>
				| { numbering: 'standard'; seasonNumber: number; episodeNumbers: number[] }
				| { numbering: 'daily'; airDate: string }
				| { numbering: 'absolute'; absoluteEpisode: number }
				| null;
		};

		const identifier = service.resolveEpisodeIdentifierWithFallback(
			'/mnt/nzbdav/completed-downloads/tv/the-night-agent/yAGGjgtaYU29DAJR7VU2EZAyThCqGmPu.mkv.strm',
			{
				title: 'The.Night.Agent.S03E10.HDR.2160p.WEB.h265-ETHEL',
				seasonNumber: 3
			},
			'standard'
		);

		expect(identifier).toEqual({
			numbering: 'standard',
			seasonNumber: 3,
			episodeNumbers: [10]
		});
	});

	it('resolves episode from parent folder when source basename is obfuscated', () => {
		const service = ImportService.getInstance() as unknown as {
			resolveEpisodeIdentifierWithFallback: (
				videoFilePath: string,
				queueItem: { title: string; seasonNumber?: number | null },
				seriesType: 'standard' | 'anime' | 'daily'
			) =>
				| { numbering: 'standard'; seasonNumber: number; episodeNumbers: number[] }
				| { numbering: 'daily'; airDate: string }
				| { numbering: 'absolute'; absoluteEpisode: number }
				| null;
		};

		const identifier = service.resolveEpisodeIdentifierWithFallback(
			'/mnt/nzbdav/completed-downloads/tv/The.Night.Agent.S03E10.HDR.2160p.WEB.h265-ETHEL/yAGGjgtaYU29DAJR7VU2EZAyThCqGmPu.mkv.strm',
			{
				title: 'Unparseable Release Name',
				seasonNumber: 3
			},
			'standard'
		);

		expect(identifier).toEqual({
			numbering: 'standard',
			seasonNumber: 3,
			episodeNumbers: [10]
		});
	});
});

describe('ImportService metadata extraction', () => {
	beforeEach(() => {
		ImportService.resetInstance();
	});

	it('falls back to source filename metadata when queue title has no quality markers', () => {
		const service = ImportService.getInstance() as unknown as {
			buildImportedMetadata: (
				queueItem: {
					title: string;
					quality?: Record<string, string>;
					releaseGroup?: string | null;
				},
				sourcePath: string,
				mediaInfo: { width?: number; height?: number; videoCodec?: string } | null
			) => {
				sceneName: string;
				releaseGroup?: string;
				quality: {
					resolution?: string;
					source?: string;
					codec?: string;
					hdr?: string;
				};
			};
		};

		const metadata = service.buildImportedMetadata(
			{
				title: 'The Lord of the Rings The Fellowship of the Ring EXTENDED (2001)'
			},
			'/tmp/The.Lord.of.the.Rings.2001.720p.BRRip.x264-GRP.mkv',
			null
		);

		expect(metadata.sceneName).toBe('The.Lord.of.the.Rings.2001.720p.BRRip.x264-GRP');
		expect(metadata.releaseGroup).toBe('GRP');
		expect(metadata.quality.resolution).toBe('720p');
		expect(metadata.quality.source).toBe('bluray');
		expect(metadata.quality.codec).toBe('h264');
	});

	it('falls back to parent folder metadata when source filename is obfuscated', () => {
		const service = ImportService.getInstance() as unknown as {
			buildImportedMetadata: (
				queueItem: {
					title: string;
					quality?: Record<string, string>;
					releaseGroup?: string | null;
				},
				sourcePath: string,
				mediaInfo: { width?: number; height?: number; videoCodec?: string } | null
			) => {
				sceneName: string;
				releaseGroup?: string;
				quality: {
					resolution?: string;
					source?: string;
					codec?: string;
					hdr?: string;
				};
			};
		};

		const metadata = service.buildImportedMetadata(
			{
				title: 'The Night Agent (2026)'
			},
			'/tmp/The.Night.Agent.S03E10.HDR.2160p.WEB.h265-ETHEL/yAGGjgtaYU29DAJR7VU2EZAyThCqGmPu.mkv.strm',
			null
		);

		expect(metadata.sceneName).toBe('The.Night.Agent.S03E10.HDR.2160p.WEB.h265-ETHEL');
		expect(metadata.releaseGroup).toBe('ETHEL');
		expect(metadata.quality.resolution).toBe('2160p');
		expect(metadata.quality.source).toBe('webrip');
		expect(metadata.quality.codec).toBe('h265');
		expect(metadata.quality.hdr).toBe('hdr');
	});

	it('uses probe metadata as fallback for resolution and codec', () => {
		const service = ImportService.getInstance() as unknown as {
			buildImportedMetadata: (
				queueItem: {
					title: string;
					quality?: Record<string, string>;
					releaseGroup?: string | null;
				},
				sourcePath: string,
				mediaInfo: { width?: number; height?: number; videoCodec?: string } | null
			) => {
				sceneName: string;
				releaseGroup?: string;
				quality: {
					resolution?: string;
					source?: string;
					codec?: string;
					hdr?: string;
				};
			};
		};

		const metadata = service.buildImportedMetadata(
			{
				title: 'The Fellowship of the Ring'
			},
			'/tmp/The.Fellowship.of.the.Ring.mkv',
			{ width: 1920, height: 1080, videoCodec: 'HEVC' }
		);

		expect(metadata.quality.resolution).toBe('1080p');
		expect(metadata.quality.codec).toBe('h265');
	});

	it('rejects a file when ffprobe cannot read media information', () => {
		// #532: an unreadable file (still downloading, corrupt, or a fragment
		// adopted by mistake) must surface as a failed file, never an import.
		const service = ImportService.getInstance() as unknown as {
			getMediaProbeFailure: (
				sourcePath: string,
				mediaInfo: Record<string, unknown> | null
			) => { success: boolean; sourcePath: string; error?: string } | null;
		};

		expect(service.getMediaProbeFailure('/downloads/corrupt.mkv', null)).toEqual({
			success: false,
			sourcePath: '/downloads/corrupt.mkv',
			error: 'Media validation failed: ffprobe could not read the file'
		});
		expect(service.getMediaProbeFailure('/downloads/valid.mkv', { width: 1920 })).toBeNull();
	});
});

describe('ImportService episode naming', () => {
	beforeEach(() => {
		ImportService.resetInstance();
	});

	it('builds fallback absolute numbering for anime when DB absolute numbers are missing', () => {
		const service = ImportService.getInstance() as unknown as {
			getFallbackAbsoluteEpisodeNumber: (
				allEpisodes: Array<{
					id: string;
					seasonNumber: number;
					episodeNumber: number;
					absoluteEpisodeNumber: number | null;
				}>,
				episodeId?: string
			) => number | undefined;
		};

		const absoluteNumber = service.getFallbackAbsoluteEpisodeNumber(
			[
				{ id: 'special', seasonNumber: 0, episodeNumber: 1, absoluteEpisodeNumber: null },
				{ id: 'ep1', seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null },
				{ id: 'ep2', seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: null },
				{ id: 'ep3', seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null }
			],
			'ep3'
		);

		expect(absoluteNumber).toBe(3);
	});
});

describe('ImportService post-import status handling', () => {
	beforeEach(() => {
		ImportService.resetInstance();
	});

	it('treats seeding-imported as already imported', () => {
		const service = ImportService.getInstance() as unknown as {
			isAlreadyImportedStatus: (status: string | null | undefined) => boolean;
		};

		expect(service.isAlreadyImportedStatus('seeding-imported')).toBe(true);
		expect(service.isAlreadyImportedStatus('imported')).toBe(true);
		expect(service.isAlreadyImportedStatus('seeding')).toBe(false);
	});
});
