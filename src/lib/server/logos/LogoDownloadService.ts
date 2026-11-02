import { writeFile, mkdir, readdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import { EventEmitter } from 'node:events';
import { invalidateLogoLibraryCache } from './logo-library.js';
import { LOGO_REPO_PATH_PREFIX, LOGOS_DIR } from './constants.js';

const GITHUB_REPO = 'Cinephage/Cinephage';
const GITHUB_BRANCH = 'main';

export interface LogoDownloadProgress {
	total: number;
	downloaded: number;
	current: string;
	status: 'idle' | 'downloading' | 'completed' | 'error';
	error?: string;
}

export class LogoDownloadService extends EventEmitter {
	private _progress: LogoDownloadProgress = {
		total: 0,
		downloaded: 0,
		current: '',
		status: 'idle'
	};

	private _abortController: AbortController | null = null;

	constructor() {
		super();
	}

	get progress(): LogoDownloadProgress {
		return { ...this._progress };
	}

	/**
	 * Check if logos have been downloaded
	 */
	async isDownloaded(): Promise<boolean> {
		try {
			const stats = await stat(LOGOS_DIR);
			if (!stats.isDirectory()) return false;

			// Check if directory has content
			const entries = await readdir(LOGOS_DIR);
			return entries.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Get download status including count if downloaded
	 */
	async getStatus(): Promise<{ downloaded: boolean; count: number; countries: number }> {
		const downloaded = await this.isDownloaded();
		if (!downloaded) {
			return { downloaded: false, count: 0, countries: 0 };
		}

		try {
			const entries = await readdir(LOGOS_DIR);
			let count = 0;
			let countries = 0;

			for (const entry of entries) {
				const entryPath = join(LOGOS_DIR, entry);
				const stats = await stat(entryPath);
				if (stats.isDirectory()) {
					countries++;
					const files = await readdir(entryPath);
					count += files.filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).length;
				}
			}

			return { downloaded: true, count, countries };
		} catch {
			return { downloaded: false, count: 0, countries: 0 };
		}
	}

	/**
	 * Download all logos from GitHub
	 */
	async download(onProgress?: (progress: LogoDownloadProgress) => void): Promise<void> {
		if (this._progress.status === 'downloading') {
			throw new Error('Download already in progress');
		}

		this._abortController = new AbortController();
		this._progress = { total: 0, downloaded: 0, current: '', status: 'downloading' };
		invalidateLogoLibraryCache();

		// Emit started event immediately BEFORE any async work
		// This ensures SSE clients get the event even if they connect late
		this.emit('started', { ...this._progress });
		logger.info('[LogoDownload] Download started');

		try {
			// Create logos directory
			await mkdir(LOGOS_DIR, { recursive: true });

			// First, get the directory listing from GitHub API
			const treeUrl = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
			logger.info({ url: treeUrl }, '[LogoDownload] Fetching repository tree');

			const treeRes = await fetch(treeUrl, {
				signal: this._abortController.signal,
				headers: {
					Accept: 'application/vnd.github.v3+json',
					'User-Agent': 'Cinephage-LogoDownloader/1.0'
				}
			});

			if (!treeRes.ok) {
				throw new Error(`Failed to fetch repository tree: ${treeRes.status}`);
			}

			const treeData = await treeRes.json();

			// Filter for logo files in the data/channel-logos/ directory
			const logoFiles = treeData.tree.filter(
				(item: { path: string; type: string }) =>
					item.type === 'blob' &&
					item.path.startsWith(LOGO_REPO_PATH_PREFIX) &&
					/\.(png|jpg|jpeg)$/i.test(item.path)
			);

			this._progress.total = logoFiles.length;
			logger.info({ count: logoFiles.length }, '[LogoDownload] Found logos to download');

			// Download each logo
			for (let i = 0; i < logoFiles.length; i++) {
				if (this._abortController.signal.aborted) {
					throw new Error('Download cancelled');
				}

				const file = logoFiles[i];
				this._progress.current = file.path;

				// Get the raw content URL
				const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${file.path}`;
				const localPath = join(LOGOS_DIR, file.path.replace(LOGO_REPO_PATH_PREFIX, ''));

				try {
					// Ensure subdirectory exists
					const dir = localPath.substring(0, localPath.lastIndexOf('/'));
					await mkdir(dir, { recursive: true });

					// Download the file
					const fileRes = await fetch(rawUrl, {
						signal: this._abortController.signal,
						headers: { 'User-Agent': 'Cinephage-LogoDownloader/1.0' }
					});

					if (!fileRes.ok) {
						logger.warn(
							{
								path: file.path,
								status: fileRes.status
							},
							'[LogoDownload] Failed to download file'
						);
						continue;
					}

					const buffer = await fileRes.arrayBuffer();
					await writeFile(localPath, Buffer.from(buffer));

					this._progress.downloaded++;

					// Emit progress event after each file
					this.emit('progress', { ...this._progress });

					// Also call callback if provided
					onProgress?.({ ...this._progress });
				} catch (err) {
					logger.warn(
						{
							path: file.path,
							error: String(err)
						},
						'[LogoDownload] Error downloading file'
					);
				}
			}

			this._progress.status = 'completed';
			this._progress.current = '';
			invalidateLogoLibraryCache();
			this.emit('completed', { ...this._progress });
			onProgress?.({ ...this._progress });

			logger.info(
				{
					total: this._progress.total,
					downloaded: this._progress.downloaded
				},
				'[LogoDownload] Download completed'
			);
		} catch (error) {
			this._progress.status = 'error';
			this._progress.error = error instanceof Error ? error.message : 'Unknown error';
			this.emit('error', { ...this._progress });
			onProgress?.({ ...this._progress });
			throw error;
		}
	}

	/**
	 * Cancel ongoing download
	 */
	cancel(): void {
		if (this._abortController) {
			this._abortController.abort();
		}
	}

	/**
	 * Remove all downloaded logos
	 */
	async remove(): Promise<void> {
		try {
			await rm(LOGOS_DIR, { recursive: true, force: true });
			this._progress = { total: 0, downloaded: 0, current: '', status: 'idle' };
			invalidateLogoLibraryCache();
			logger.info('[LogoDownload] All logos removed');
		} catch (error) {
			logger.error({ err: error }, '[LogoDownload] Failed to remove logos');
			throw error;
		}
	}
}

// Singleton instance
let _instance: LogoDownloadService | null = null;

export function getLogoDownloadService(): LogoDownloadService {
	if (!_instance) {
		_instance = new LogoDownloadService();
	}
	return _instance;
}
