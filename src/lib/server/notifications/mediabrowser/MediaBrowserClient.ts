/**
 * Media server notification client.
 *
 * Jellyfin and Emby share the MediaBrowser API. Plex uses a different API and
 * falls back to library refresh requests instead of per-file update payloads.
 */

import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';
import { resolveAppVersion } from '#lib/server/version.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import type {
	MediaBrowserPathMapping,
	MediaBrowserServerType,
	MediaBrowserTestResult,
	LibraryUpdatePayload,
	MediaBrowserSystemInfo,
	PlexIdentityInfo,
	PlexLibraryLocation
} from './types';

const XML_PARSER = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	parseTagValue: false
});

export interface MediaBrowserClientConfig {
	host: string;
	apiKey: string;
	serverType: MediaBrowserServerType;
}

export class MediaBrowserClient {
	private readonly host: string;
	private readonly apiKey: string;
	private readonly serverType: MediaBrowserServerType;

	constructor(config: MediaBrowserClientConfig) {
		// Normalize host - remove trailing slash
		this.host = config.host.replace(/\/+$/, '');
		this.apiKey = config.apiKey;
		this.serverType = config.serverType;
	}

	/**
	 * Detect which product runs at `host` by probing the endpoints each server
	 * exposes. Never infers from a version number: Jellyfin/Emby report their
	 * ProductName, Plex answers `/identity` with a machine identifier.
	 *
	 * Returns null when nothing identifiable answers (unreachable, not a media
	 * server, or all probes fail).
	 */
	static async detectServerType(
		host: string,
		apiKey?: string
	): Promise<{
		type: MediaBrowserServerType;
		productName?: string;
		version?: string;
		serverName?: string;
		id?: string;
	} | null> {
		const normalizedHost = host.replace(/\/+$/, '');
		const timeout = AbortSignal.timeout(8000);

		// Jellyfin/Emby: the public system info endpoint needs no auth and
		// carries ProductName. Fall back to the authenticated endpoint for
		// older builds that omit it.
		try {
			const response = await fetch(`${normalizedHost}/System/Info/Public`, {
				headers: { Accept: 'application/json' },
				signal: timeout
			});
			if (response.ok) {
				const data = (await response.json()) as MediaBrowserSystemInfo;
				const product = (data.ProductName ?? '').toLowerCase();
				const detected = product.includes('jellyfin')
					? 'jellyfin'
					: product.includes('emby')
						? 'emby'
						: null;
				if (detected) {
					return {
						type: detected,
						productName: data.ProductName,
						version: data.Version,
						serverName: data.ServerName,
						id: data.Id
					};
				}
			}
		} catch {
			// Probe failed; try the next product.
		}

		if (apiKey) {
			// Try each MediaBrowser auth style; Emby and Jellyfin differ on which
			// they accept, and older builds omit ProductName from /Public.
			for (const candidate of ['jellyfin', 'emby'] as MediaBrowserServerType[]) {
				try {
					const response = await fetch(`${normalizedHost}/System/Info`, {
						headers: {
							...MediaBrowserClient.authHeadersFor(candidate, apiKey),
							Accept: 'application/json'
						},
						signal: AbortSignal.timeout(8000)
					});
					if (response.ok) {
						const data = (await response.json()) as MediaBrowserSystemInfo;
						const product = (data.ProductName ?? '').toLowerCase();
						const detected = product.includes('jellyfin')
							? 'jellyfin'
							: product.includes('emby')
								? 'emby'
								: null;
						if (detected) {
							return {
								type: detected,
								productName: data.ProductName,
								version: data.Version,
								serverName: data.ServerName,
								id: data.Id
							};
						}
					}
				} catch {
					// Try the next auth style.
				}
			}
		}

		// Plex: /identity is unauthenticated and returns a MediaContainer with
		// machineIdentifier/version.
		try {
			const response = await fetch(`${normalizedHost}/identity`, {
				headers: { Accept: 'application/xml' },
				signal: AbortSignal.timeout(8000)
			});
			if (response.ok) {
				const parsed = XML_PARSER.parse(await response.text()) as {
					MediaContainer?: PlexIdentityInfo;
				};
				const identity = parsed.MediaContainer;
				if (identity?.machineIdentifier) {
					return {
						type: 'plex',
						version: identity.version,
						serverName: identity.friendlyName ?? 'Plex',
						id: identity.machineIdentifier
					};
				}
			}
		} catch {
			// Not Plex.
		}

		return null;
	}

	/**
	 * Auth headers for a MediaBrowser-family server type.
	 *
	 * Jellyfin 12.x rejects the bare `X-Emby-Token`/`MediaBrowser Token=`
	 * shortcuts and requires the full composite Authorization header; Emby
	 * accepts its own token header. Shared so notifications and media-server
	 * stats authenticate identically.
	 */
	static authHeadersFor(
		serverType: MediaBrowserServerType,
		apiKey: string
	): Record<string, string> {
		if (serverType === 'emby') {
			return { 'X-Emby-Token': apiKey };
		}
		return {
			Authorization: `MediaBrowser Client="Cinephage", Device="Cinephage", DeviceId="cinephage-server", Version="${resolveAppVersion()}", Token="${apiKey}"`
		};
	}

	/**
	 * Test connection to the MediaBrowser server
	 */
	async test(): Promise<MediaBrowserTestResult> {
		try {
			if (this.serverType === 'plex') {
				return await this.testPlex();
			}

			const response = await this.requestMediaBrowser('/System/Info');

			if (!response.ok) {
				if (response.status === 401) {
					// Auth rejected for the selected type. The server may be the
					// other MediaBrowser product (Jellyfin vs Emby have different
					// token headers): detect what actually runs and retry once.
					const detected = await MediaBrowserClient.detectServerType(this.host, this.apiKey);
					if (detected && detected.type !== this.serverType && detected.type !== 'plex') {
						const retryClient = new MediaBrowserClient({
							host: this.host,
							apiKey: this.apiKey,
							serverType: detected.type
						});
						const retry = await retryClient.test();
						if (retry.success) return retry;
					}
					return { success: false, error: 'Invalid API key' };
				}
				return {
					success: false,
					error: `Server returned ${response.status}: ${response.statusText}`
				};
			}

			const data = (await response.json()) as MediaBrowserSystemInfo;
			const detected = await MediaBrowserClient.detectServerType(this.host, this.apiKey);

			return {
				success: true,
				serverInfo: {
					serverName: data.ServerName,
					version: data.Version,
					id: data.Id,
					detectedType: detected?.type ?? this.serverType,
					productName: data.ProductName ?? detected?.productName
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			if (message.includes('ECONNREFUSED')) {
				return { success: false, error: 'Connection refused - is the server running?' };
			}
			if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
				return { success: false, error: 'Host not found - check the server address' };
			}
			if (message.includes('ETIMEDOUT')) {
				return { success: false, error: 'Connection timed out' };
			}

			return { success: false, error: message };
		}
	}

	private async testPlex(): Promise<MediaBrowserTestResult> {
		const response = await this.requestPlex('/');

		if (!response.ok) {
			if (response.status === 401) {
				return { success: false, error: 'Invalid Plex token' };
			}

			return {
				success: false,
				error: `Server returned ${response.status}: ${response.statusText}`
			};
		}

		const data = this.parsePlexIdentity(await response.text());

		return {
			success: true,
			serverInfo: {
				serverName: data.friendlyName ?? 'Plex',
				version: data.version ?? 'unknown',
				id: data.machineIdentifier ?? 'unknown',
				detectedType: 'plex'
			}
		};
	}

	/**
	 * Notify the server about library updates.
	 *
	 * Returns whether the notification actually succeeded.
	 */
	async notifyLibraryUpdate(payload: LibraryUpdatePayload): Promise<boolean> {
		if (this.serverType === 'plex') {
			await this.notifyPlexLibraryUpdate(payload);
			return true;
		}

		try {
			const response = await this.requestMediaBrowser('/Library/Media/Updated', {
				method: 'POST',
				body: JSON.stringify(payload)
			});

			if (!response.ok) {
				logger.warn(
					{
						serverType: this.serverType,
						status: response.status,
						statusText: response.statusText
					},
					'MediaBrowser library update failed'
				);
				return false;
			}

			logger.debug(
				{
					serverType: this.serverType,
					updates: payload.Updates.length
				},
				'MediaBrowser library update sent'
			);
			return true;
		} catch (error) {
			logger.error(
				{
					serverType: this.serverType,
					error: error instanceof Error ? error.message : String(error)
				},
				'MediaBrowser library update error'
			);
			return false;
		}
	}

	private async notifyPlexLibraryUpdate(payload: LibraryUpdatePayload): Promise<void> {
		const paths = [
			...new Set(
				payload.Updates.map((update) => update.Path)
					.filter(Boolean)
					.map((updatePath) => this.getPlexRefreshPath(updatePath))
			)
		];

		if (paths.length === 0) {
			return;
		}

		try {
			const sections = await this.getPlexLibraryLocations();
			const refreshedSectionIds = new Set<string>();
			let refreshedAny = false;

			for (const path of paths) {
				const matchingSections = sections.filter(
					(section) =>
						this.pathContains(section.path, path) || this.pathContains(path, section.path)
				);

				if (matchingSections.length === 0) {
					logger.debug('Plex library refresh found no matching section', {
						path,
						knownSections: sections.map((section) => section.path)
					});
					continue;
				}

				for (const section of matchingSections) {
					const refreshPath = `${this.host}/library/sections/${encodeURIComponent(section.id)}/refresh?path=${encodeURIComponent(path)}`;
					const response = await this.requestPlex(refreshPath, { method: 'POST' }, true);

					if (response.ok) {
						refreshedAny = true;
						refreshedSectionIds.add(section.id);
						logger.debug('Plex library refresh triggered', {
							sectionId: section.id,
							sectionPath: section.path,
							refreshPath: path
						});
					} else {
						logger.warn('Plex library refresh failed', {
							status: response.status,
							statusText: response.statusText,
							path,
							sectionId: section.id
						});
					}
				}
			}

			if (!refreshedAny && refreshedSectionIds.size === 0) {
				logger.debug('Plex library refresh falling back to full refresh', {
					paths
				});
				await this.refreshLibrary();
			}
		} catch (error) {
			logger.error('Plex library update error', {
				error: error instanceof Error ? error.message : String(error)
			});
			await this.refreshLibrary();
		}
	}

	/**
	 * Trigger a full library refresh (fallback)
	 */
	async refreshLibrary(): Promise<void> {
		try {
			const response =
				this.serverType === 'plex'
					? await this.requestPlex('/library/sections/all/refresh', { method: 'POST' })
					: await this.requestMediaBrowser('/Library/Refresh', {
							method: 'POST'
						});

			if (!response.ok) {
				logger.warn(
					{
						serverType: this.serverType,
						status: response.status
					},
					'Media server library refresh failed'
				);
			} else {
				logger.debug(
					{
						serverType: this.serverType
					},
					'Media server library refresh triggered'
				);
			}
		} catch (error) {
			logger.error(
				{
					serverType: this.serverType,
					error: error instanceof Error ? error.message : String(error)
				},
				'Media server library refresh error'
			);
		}
	}

	/**
	 * Delete an item from a Jellyfin/Emby server.
	 *
	 * DESTRUCTIVE: the upstream MediaBrowser API deletes the item's file
	 * location as well (`DeleteOptions { DeleteFileLocation = true }` in
	 * Jellyfin/Emby), and API-key auth bypasses their content-deletion
	 * permission check. Callers MUST only invoke this once the file has
	 * already been moved or removed locally, so the server's stored path is
	 * stale and the file-location deletion is a no-op on disk. Used
	 * post-rename to clear the old entry + all child rows (jellyfin#16883).
	 *
	 * Plex does not support item deletion via API; returns false for Plex.
	 */
	async deleteItem(itemId: string): Promise<boolean> {
		if (this.serverType === 'plex') return false;
		try {
			const response = await this.requestMediaBrowser(`/Items/${itemId}`, { method: 'DELETE' });
			if (response.ok || response.status === 404) {
				logger.debug({ serverType: this.serverType, itemId }, 'Media server item deleted');
				return true;
			}
			logger.warn(
				{ serverType: this.serverType, itemId, status: response.status },
				'Media server item deletion failed'
			);
			return false;
		} catch (error) {
			logger.warn(
				{
					serverType: this.serverType,
					itemId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Media server item deletion error'
			);
			return false;
		}
	}

	/**
	 * Make an HTTP request to a Jellyfin/Emby server.
	 */
	private async requestMediaBrowser(path: string, options: RequestInit = {}): Promise<Response> {
		const url = `${this.host}${path}`;

		const headers = new Headers(options.headers);
		// Shared auth header builder. Jellyfin 12.x rejects the bare
		// X-MediaBrowser-Token/X-Emby-Token shortcuts outright (401, regardless
		// of key validity) and requires the full composite Authorization header;
		// Emby keeps its token header.
		for (const [name, value] of Object.entries(
			MediaBrowserClient.authHeadersFor(this.serverType, this.apiKey)
		)) {
			headers.set(name, value);
		}
		headers.set('Accept', 'application/json');

		if (options.body) {
			headers.set('Content-Type', 'application/json');
		}

		return fetch(url, {
			...options,
			headers,
			signal: AbortSignal.timeout(10000) // 10 second timeout
		});
	}

	/**
	 * Make an HTTP request to a Plex server.
	 */
	private async requestPlex(
		pathOrUrl: string,
		options: RequestInit = {},
		isAbsoluteUrl = false
	): Promise<Response> {
		const url = isAbsoluteUrl ? pathOrUrl : `${this.host}${pathOrUrl}`;
		const headers = new Headers(options.headers);
		headers.set('X-Plex-Token', this.apiKey);
		headers.set('Accept', 'application/xml');

		return fetch(url, {
			...options,
			headers,
			signal: AbortSignal.timeout(10000)
		});
	}

	private parsePlexIdentity(xml: string): PlexIdentityInfo {
		const parsed = XML_PARSER.parse(xml) as {
			MediaContainer?: PlexIdentityInfo;
		};

		return parsed.MediaContainer ?? {};
	}

	private async getPlexLibraryLocations(): Promise<PlexLibraryLocation[]> {
		const response = await this.requestPlex('/library/sections');

		if (!response.ok) {
			throw new Error(`Plex library lookup failed: ${response.status} ${response.statusText}`);
		}

		const parsed = XML_PARSER.parse(await response.text()) as {
			MediaContainer?: {
				Directory?:
					| Array<{
							key?: string;
							Location?: { path?: string } | Array<{ path?: string }>;
					  }>
					| {
							key?: string;
							Location?: { path?: string } | Array<{ path?: string }>;
					  };
			};
		};

		const sections = this.asArray(parsed.MediaContainer?.Directory);
		const locations: PlexLibraryLocation[] = [];

		for (const section of sections) {
			const sectionId = section.key;
			if (!sectionId) continue;

			for (const location of this.asArray(section.Location)) {
				if (location?.path) {
					locations.push({ id: sectionId, path: location.path });
				}
			}
		}

		return locations;
	}

	private asArray<T>(value: T | T[] | undefined): T[] {
		if (!value) return [];
		return Array.isArray(value) ? value : [value];
	}

	private pathContains(basePath: string, candidatePath: string): boolean {
		const normalizedBase = this.normalizePath(basePath);
		const normalizedCandidate = this.normalizePath(candidatePath);
		return (
			normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}/`)
		);
	}

	private normalizePath(path: string): string {
		return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	private getPlexRefreshPath(mediaPath: string): string {
		const normalized = mediaPath.replace(/\\/g, '/');
		return path.posix.dirname(normalized);
	}

	/**
	 * Map a local path to a remote path using the configured mappings
	 */
	static mapPath(localPath: string, mappings: MediaBrowserPathMapping[] | null): string {
		if (!mappings || mappings.length === 0) {
			return localPath;
		}

		// Normalize the local path
		const normalizedLocal = localPath.replace(/\/+$/, '');

		for (const mapping of mappings) {
			const normalizedFrom = mapping.localPath.replace(/\/+$/, '');

			if (normalizedLocal.startsWith(normalizedFrom)) {
				const relativePath = normalizedLocal.slice(normalizedFrom.length);
				const normalizedTo = mapping.remotePath.replace(/\/+$/, '');
				return normalizedTo + relativePath;
			}
		}

		// No mapping matched, return original path
		return localPath;
	}
}
