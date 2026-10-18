import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { ensureMediaDirectory } from '#lib/server/filesystem/mkdir-helpers.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { EphemeralLink } from './debrid-adapter';
import { redactDebridDiagnostic } from './diagnostics';

interface MaterializerAdapter {
	resolveFreshLink(providerItemId: string, providerFileId: string): Promise<EphemeralLink>;
}

interface MaterializeInput {
	providerItemId: string;
	providerFileId: string;
	providerSizeBytes: number;
	plan: { fileName: string; relativePath: string; finalPath: string };
	rootPath: string;
	signal?: AbortSignal;
}

export interface DebridFileMaterializeReceipt {
	finalPath: string;
	sizeBytes: number;
	createdByAttempt: boolean;
	replacedExisting: boolean;
}

const activeFinalPaths = new Set<string>();

export class DebridFileMaterializer {
	constructor(
		private readonly options: {
			adapter: MaterializerAdapter;
			connectTimeoutMs?: number;
			readTimeoutMs?: number;
			maxRedirects?: number;
		}
	) {}

	async materialize(input: MaterializeInput): Promise<DebridFileMaterializeReceipt> {
		this.validatePlan(input.plan, input.rootPath);
		const finalPath = resolve(input.plan.finalPath);
		const directory = dirname(finalPath);
		await this.preflight(input.rootPath, directory, finalPath);
		if (activeFinalPaths.has(finalPath)) {
			throw new Error('Materialization final path is already being written');
		}
		activeFinalPaths.add(finalPath);

		let tempPath: string | undefined;
		try {
			const linkInfo = await this.options.adapter.resolveFreshLink(
				input.providerItemId,
				input.providerFileId
			);
			this.validateSize(input.providerSizeBytes, linkInfo.sizeBytes);
			tempPath = resolve(directory, `.${input.plan.fileName}.${randomUUID()}.tmp`);
			const result = await this.download(linkInfo.url, tempPath, input.signal);
			this.validateSize(input.providerSizeBytes, result.sizeBytes, linkInfo.sizeBytes);
			if (result.contentLength !== undefined && result.contentLength !== result.sizeBytes) {
				throw new Error('Downloaded file was truncated');
			}

			await this.preflight(input.rootPath, directory, finalPath);
			await rename(tempPath, finalPath);
			tempPath = undefined;
			return {
				finalPath,
				sizeBytes: result.sizeBytes,
				createdByAttempt: true,
				replacedExisting: false
			};
		} catch (error) {
			if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
			throw new Error(
				redactDebridDiagnostic(error instanceof Error ? error.message : 'Materialization failed'),
				{ cause: error }
			);
		} finally {
			activeFinalPaths.delete(finalPath);
		}
	}

	private validatePlan(plan: MaterializeInput['plan'], rootPath: string): void {
		if (
			!plan.fileName ||
			basename(plan.fileName) !== plan.fileName ||
			plan.fileName.includes('\\')
		) {
			throw new Error('Invalid materialization filename');
		}
		if (!isAbsolute(plan.finalPath) || basename(plan.finalPath) !== plan.fileName) {
			throw new Error('Materialization final path is invalid');
		}
		if (!contained(resolve(rootPath), resolve(plan.finalPath))) {
			throw new Error('Materialization final path escapes the library root');
		}
	}

	private async preflight(rootPath: string, directory: string, finalPath: string): Promise<void> {
		await ensureMediaDirectory(directory);
		const directoryStat = await lstat(directory);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
			throw new Error('Materialization destination parent is a symlink or is unsafe');
		}
		if (!contained(await realpath(resolve(rootPath)), await realpath(directory))) {
			throw new Error('Materialization destination escapes the real library root');
		}
		try {
			await lstat(finalPath);
			throw new Error('Materialization final path collision would clobber an existing file');
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') return;
			throw error;
		}
	}

	private validateSize(providerSize: number, actualSize?: number, linkSize?: number): void {
		if (!Number.isSafeInteger(providerSize) || providerSize <= 0) {
			throw new Error('Provider file size must be a positive safe integer');
		}
		for (const size of [actualSize, linkSize]) {
			if (size !== undefined && size !== providerSize)
				throw new Error('Downloaded file size mismatch');
		}
	}

	private async download(
		value: string,
		tempPath: string,
		signal?: AbortSignal,
		redirects = 0
	): Promise<{ sizeBytes: number; contentLength?: number }> {
		if (signal?.aborted) throw new Error('Materialization cancelled before transfer');
		const url = this.downloadUrl(value);
		return new Promise((resolvePromise, rejectPromise) => {
			const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
				url,
				{ method: 'GET', signal },
				(response) => {
					clearTimeout(connectTimer);
					if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
						response.resume();
						if (!response.headers.location) {
							rejectPromise(new Error('Provider redirect missing location'));
							return;
						}
						if (redirects >= (this.options.maxRedirects ?? 3)) {
							rejectPromise(new Error('Provider redirect limit exceeded'));
							return;
						}
						void this.download(
							new URL(response.headers.location, url).toString(),
							tempPath,
							signal,
							redirects + 1
						).then(resolvePromise, rejectPromise);
						return;
					}
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						response.resume();
						rejectPromise(new Error(`Provider download failed with HTTP ${response.statusCode}`));
						return;
					}

					let bytes = 0;
					response.on('data', (chunk: Buffer) => (bytes += chunk.length));
					response.setTimeout(this.options.readTimeoutMs ?? 30_000, () =>
						response.destroy(new Error('Provider download read timeout'))
					);
					void pipeline(response, createWriteStream(tempPath, { flags: 'wx' })).then(
						() =>
							resolvePromise({
								sizeBytes: bytes,
								contentLength: parseContentLength(response.headers['content-length'])
							}),
						(error) => rejectPromise(new Error('Provider download network error', { cause: error }))
					);
				}
			);
			const connectTimer = setTimeout(
				() => request.destroy(new Error('Provider download connection timeout')),
				this.options.connectTimeoutMs ?? 10_000
			);
			request.once('error', (error) => {
				clearTimeout(connectTimer);
				rejectPromise(
					signal?.aborted || error.name === 'AbortError' || /timeout/i.test(error.message)
						? error
						: new Error('Provider download network error', { cause: error })
				);
			});
			request.end();
		});
	}

	private downloadUrl(value: string): URL {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error('Provider download URL is invalid');
		}
		const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
		if (url.protocol !== 'https:' && !localHttp) {
			throw new Error('Provider download URL must use HTTPS');
		}
		return url;
	}
}

function contained(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
	const parsed = Number(Array.isArray(value) ? value[0] : value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
