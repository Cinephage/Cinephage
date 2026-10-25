/**
 * Download handler for YAML indexer definitions.
 * Resolves download URLs, handles before blocks, extracts from selectors, and builds magnet links.
 */

import * as cheerio from 'cheerio';
import type {
	YamlDefinition as CardigannDefinition,
	DownloadBlock,
	SelectorBlock
} from '../schema/yamlDefinition';
import { TemplateEngine } from '../engine/TemplateEngine';
import { FilterEngine } from '../engine/FilterEngine';
import { SelectorEngine } from '../engine/SelectorEngine';
import { CookieStore } from '../auth/CookieStore';
import { cloudflareFetch } from '../http/cloudflare-fetch';
import { createChildLogger } from '#lib/logging/index.js';

export interface DownloadContext {
	baseUrl: string;
	cookies: Record<string, string>;
	settings: Record<string, unknown>;
	encoding?: string;
	releaseDetailsUrl?: string;
	releaseGuid?: string;
	releaseTitle?: string;
}

export interface DownloadRequest {
	url: string;
	method: 'GET' | 'POST';
	headers: Record<string, string>;
	body?: URLSearchParams;
}

export interface DownloadResult {
	success: boolean;
	request?: DownloadRequest;
	magnetUrl?: string;
	/** Cached torrent file bytes from testTorrentLink validation, avoids redundant second fetch */
	torrentData?: Buffer;
	error?: string;
}

export class DownloadHandler {
	private definition: CardigannDefinition;
	private templateEngine: TemplateEngine;
	private filterEngine: FilterEngine;
	private selectorEngine: SelectorEngine;
	private readonly log: ReturnType<typeof createChildLogger>;

	constructor(
		definition: CardigannDefinition,
		templateEngine: TemplateEngine,
		filterEngine: FilterEngine,
		selectorEngine: SelectorEngine
	) {
		this.definition = definition;
		this.templateEngine = templateEngine;
		this.filterEngine = filterEngine;
		this.selectorEngine = selectorEngine;
		this.log = createChildLogger({ indexer: definition.id, module: 'DownloadHandler' });
	}

	/**
	 * Resolve a download URL and return the request to make.
	 * For simple cases, this just returns the URL with auth headers.
	 * For complex cases, it may need to fetch pages and extract URLs.
	 */
	async resolveDownload(downloadUrl: string, context: DownloadContext): Promise<DownloadResult> {
		// Set up template variables
		this.templateEngine.setSiteLink(context.baseUrl);
		this.templateEngine.setConfigWithDefaults(context.settings, this.definition.settings ?? []);
		this.setDownloadUriVariables(downloadUrl);

		const download = this.definition.download;

		// Build headers
		const headers = this.buildHeaders(download, context);

		// No download block - just use the URL directly
		if (!download) {
			return {
				success: true,
				request: {
					url: downloadUrl,
					method: 'GET',
					headers
				}
			};
		}

		// Extract download variables if defined
		if (download.downloadVariables?.length) {
			this.log.debug(
				{
					downloadVariablesCount: download.downloadVariables.length,
					downloadVariablesFrom: download.downloadVariablesFrom,
					releaseDetailsUrl: context.releaseDetailsUrl,
					releaseGuid: context.releaseGuid
				},
				'Starting download variable extraction'
			);
			const extractedVariables = await this.extractDownloadVariables(download, context, headers);
			for (const [name, value] of Object.entries(extractedVariables)) {
				this.templateEngine.setVariable(`.Variables.${name}`, value);
				this.log.debug({ name, value: value?.substring(0, 50) }, 'Set download variable');
			}
		}

		try {
			const method = download.method?.toUpperCase() === 'POST' ? 'POST' : 'GET';
			let beforeResponse: { content: string; response: Response } | null = null;

			// Handle before block
			if (download.before) {
				beforeResponse = await this.executeBefore(download.before, downloadUrl, context, headers);
			}

			// Handle infohash block (build magnet from extracted hash/title)
			if (download.infohash) {
				const result = await this.handleInfohash(
					download,
					downloadUrl,
					context,
					headers,
					beforeResponse
				);
				if (result.success) {
					return result;
				}
				// Fall through to try selectors if infohash failed
			}

			// Handle selectors block (extract actual download URL)
			if (download.selectors && download.selectors.length > 0) {
				const result = await this.handleSelectors(
					download,
					downloadUrl,
					context,
					headers,
					beforeResponse
				);
				if (result.success) {
					return result;
				}
			}

			// No special handling - return direct download
			return {
				success: true,
				request: {
					url: downloadUrl,
					method: method as 'GET' | 'POST',
					headers
				}
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Set template variables from download URL.
	 */
	private setDownloadUriVariables(url: string): void {
		try {
			const parsed = new URL(url);
			this.templateEngine.setVariable('.DownloadUri.AbsoluteUri', url);
			this.templateEngine.setVariable('.DownloadUri.AbsolutePath', parsed.pathname);
			this.templateEngine.setVariable('.DownloadUri.Scheme', parsed.protocol.replace(':', ''));
			this.templateEngine.setVariable('.DownloadUri.Host', parsed.host);
			this.templateEngine.setVariable('.DownloadUri.Query', parsed.search);
			this.templateEngine.setVariable('.DownloadUri.Fragment', parsed.hash);

			// Parse query parameters
			for (const [key, value] of parsed.searchParams) {
				this.templateEngine.setVariable(`.DownloadUri.Query.${key}`, value);
			}

			// Parse path segments
			const segments = parsed.pathname.split('/').filter(Boolean);
			segments.forEach((segment, i) => {
				this.templateEngine.setVariable(`.DownloadUri.Segments.${i}`, segment);
			});
		} catch {
			// Invalid URL, set minimal variables
			this.templateEngine.setVariable('.DownloadUri.AbsoluteUri', url);
		}
	}

	/**
	 * Build request headers from download/search definition.
	 */
	private buildHeaders(
		download: DownloadBlock | undefined,
		context: DownloadContext
	): Record<string, string> {
		const headers: Record<string, string> = {
			Referer: context.baseUrl
		};

		// Add cookies
		if (Object.keys(context.cookies).length > 0) {
			headers['Cookie'] = CookieStore.buildCookieHeader(context.cookies);
		}

		// Add definition headers (download headers override search headers)
		const definitionHeaders = download?.headers ?? this.definition.search?.headers;
		if (definitionHeaders) {
			for (const [key, values] of Object.entries(definitionHeaders)) {
				headers[key] = this.templateEngine.expand(values[0]);
			}
		}

		return headers;
	}

	/**
	 * Execute before block to prepare for download.
	 */
	private async executeBefore(
		before: NonNullable<DownloadBlock['before']>,
		downloadUrl: string,
		context: DownloadContext,
		headers: Record<string, string>
	): Promise<{ content: string; response: Response }> {
		let beforePath = before.path ?? '';

		// If pathselector is defined, fetch the page and extract the path
		if (before.pathselector) {
			const response = await cloudflareFetch(downloadUrl, {
				method: 'GET',
				headers,
				timeout: 30000,
				encoding: context.encoding
			});
			const $ = cheerio.load(response.body);

			const pathResult = this.selectorEngine.selectHtml($, $.root(), before.pathselector, false);
			if (pathResult.value) {
				beforePath = pathResult.value;
			}
		}

		// Build before request URL
		const beforeUrl = this.resolveUrl(this.templateEngine.expand(beforePath), downloadUrl);

		// Build request body if inputs are defined
		let body: URLSearchParams | undefined;
		if (before.inputs) {
			body = new URLSearchParams();
			for (const [key, value] of Object.entries(before.inputs)) {
				body.append(key, this.templateEngine.expand(value));
			}
		}

		const method = before.method?.toUpperCase() === 'POST' ? 'POST' : 'GET';
		const requestHeaders = { ...headers };

		if (method === 'POST') {
			requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
		}

		const response = await cloudflareFetch(beforeUrl, {
			method: method as 'GET' | 'POST',
			headers: requestHeaders,
			body: method === 'POST' ? body?.toString() : undefined,
			timeout: 30000,
			encoding: context.encoding
		});

		return {
			content: response.body,
			response: new Response(response.body, {
				status: response.status,
				headers: response.headers
			})
		};
	}

	/**
	 * Handle infohash block - extract hash and title to build magnet link.
	 */
	private async handleInfohash(
		download: DownloadBlock,
		downloadUrl: string,
		context: DownloadContext,
		headers: Record<string, string>,
		beforeResponse: { content: string; response: Response } | null
	): Promise<DownloadResult> {
		const infohash = download.infohash;
		if (!infohash || !infohash.hash) {
			return { success: false, error: 'Infohash block missing hash selector' };
		}

		let content: string;

		// Use before response if specified, otherwise fetch the page
		if (infohash.usebeforeresponse && beforeResponse) {
			content = beforeResponse.content;
		} else {
			const cfResponse = await cloudflareFetch(downloadUrl, {
				method: 'GET',
				headers,
				timeout: 30000,
				encoding: context.encoding
			});
			content = cfResponse.body;
		}

		const $ = cheerio.load(content);

		// Extract hash
		const hashResult = this.selectorEngine.selectHtml($, $.root(), infohash.hash, false);
		if (!hashResult.value) {
			return { success: false, error: 'InfoHash selector did not match hash' };
		}

		// Extract title
		let title = 'Unknown';
		if (infohash.title) {
			const titleResult = this.selectorEngine.selectHtml($, $.root(), infohash.title, false);
			if (titleResult.value) {
				title = titleResult.value;
			}
		}

		// Build magnet link
		const magnetUrl = this.buildMagnetLink(hashResult.value, title);

		return {
			success: true,
			magnetUrl,
			request: {
				url: magnetUrl,
				method: 'GET',
				headers
			}
		};
	}

	/**
	 * Handle selectors block - extract download URL from page.
	 */
	private async handleSelectors(
		download: DownloadBlock,
		downloadUrl: string,
		context: DownloadContext,
		headers: Record<string, string>,
		beforeResponse: { content: string; response: Response } | null
	): Promise<DownloadResult> {
		const selectors = download.selectors;
		if (!selectors || selectors.length === 0) {
			return { success: false, error: 'No download selectors defined' };
		}

		const method = download.method?.toUpperCase() === 'POST' ? 'POST' : 'GET';
		const candidateUrls: string[] = [downloadUrl];
		if (context.releaseDetailsUrl && context.releaseDetailsUrl !== downloadUrl) {
			candidateUrls.push(context.releaseDetailsUrl);
		}
		const contentCache = new Map<string, string>();

		const getPageContent = async (url: string): Promise<string | null> => {
			const cached = contentCache.get(url);
			if (cached !== undefined) {
				return cached;
			}
			try {
				const response = await cloudflareFetch(url, {
					method: 'GET',
					headers,
					timeout: 30000,
					encoding: context.encoding
				});
				contentCache.set(url, response.body);
				return response.body;
			} catch {
				return null;
			}
		};

		for (const selector of selectors) {
			try {
				// Check if the selector is a template that expands to a URL (not CSS).
				// This supports the downloadVariables pattern where the selector value
				// IS the download URL (e.g., nCore: {{ .Variables.fullDownloadUrl }}).
				// Discriminator: URL-as-selector has no 'attribute' field, since the expanded
				// template IS the URL — there's no HTML element to extract an attribute from.
				// All CSS-based selectors have 'attribute: href' to extract the link.
				if (selector.selector && !selector.attribute) {
					const expanded = this.templateEngine.expand(selector.selector);
					if (expanded && expanded !== selector.selector && this.isUrlLikeString(expanded)) {
						this.log.debug(
							{
								original: selector.selector,
								expanded: expanded.substring(0, 80)
							},
							'Selector expanded to URL, using directly as download link'
						);
						const resolvedUrl = this.resolveUrl(expanded, downloadUrl);

						if (resolvedUrl.startsWith('magnet:')) {
							return {
								success: true,
								magnetUrl: resolvedUrl,
								request: {
									url: resolvedUrl,
									method: method as 'GET' | 'POST',
									headers
								}
							};
						}

						if (this.definition.testlinktorrent !== false) {
							const testResult = await this.testTorrentLink(resolvedUrl, headers);
							if (!testResult.valid) {
								continue;
							}
							return {
								success: true,
								torrentData: testResult.data,
								request: {
									url: resolvedUrl,
									method: method as 'GET' | 'POST',
									headers
								}
							};
						}

						return {
							success: true,
							request: {
								url: resolvedUrl,
								method: method as 'GET' | 'POST',
								headers
							}
						};
					}
				}

				let content: string;
				if (selector.usebeforeresponse && beforeResponse) {
					content = beforeResponse.content;
					const $ = cheerio.load(content);
					const result = this.selectorEngine.selectHtml(
						$,
						$.root(),
						selector as SelectorBlock,
						false
					);
					if (!result.value) {
						continue;
					}

					const resolvedUrl = this.resolveUrl(result.value, downloadUrl);
					if (resolvedUrl.startsWith('magnet:')) {
						return {
							success: true,
							magnetUrl: resolvedUrl,
							request: {
								url: resolvedUrl,
								method: method as 'GET' | 'POST',
								headers
							}
						};
					}

					if (this.definition.testlinktorrent !== false) {
						const testResult = await this.testTorrentLink(resolvedUrl, headers);
						if (!testResult.valid) {
							continue;
						}
						return {
							success: true,
							torrentData: testResult.data,
							request: {
								url: resolvedUrl,
								method: method as 'GET' | 'POST',
								headers
							}
						};
					}

					return {
						success: true,
						request: {
							url: resolvedUrl,
							method: method as 'GET' | 'POST',
							headers
						}
					};
				}

				for (const candidateUrl of candidateUrls) {
					const candidateContent = await getPageContent(candidateUrl);
					if (!candidateContent) {
						continue;
					}

					const $ = cheerio.load(candidateContent);
					const result = this.selectorEngine.selectHtml(
						$,
						$.root(),
						selector as SelectorBlock,
						false
					);
					if (!result.value) {
						continue;
					}

					const resolvedUrl = this.resolveUrl(result.value, candidateUrl);
					if (resolvedUrl.startsWith('magnet:')) {
						return {
							success: true,
							magnetUrl: resolvedUrl,
							request: {
								url: resolvedUrl,
								method: method as 'GET' | 'POST',
								headers
							}
						};
					}

					if (this.definition.testlinktorrent !== false) {
						const testResult = await this.testTorrentLink(resolvedUrl, headers);
						if (!testResult.valid) {
							continue;
						}
						return {
							success: true,
							torrentData: testResult.data,
							request: {
								url: resolvedUrl,
								method: method as 'GET' | 'POST',
								headers
							}
						};
					}

					return {
						success: true,
						request: {
							url: resolvedUrl,
							method: method as 'GET' | 'POST',
							headers
						}
					};
				}
			} catch {
				// Try next selector on error
				continue;
			}
		}

		return { success: false, error: 'Download selectors did not match' };
	}

	/**
	 * Test if a URL returns a valid torrent file.
	 * Returns the fetched bytes when valid so they can be cached and reused,
	 * avoiding a redundant second fetch (critical for one-time download tokens).
	 */
	private async testTorrentLink(
		url: string,
		headers: Record<string, string>
	): Promise<{ valid: boolean; data?: Buffer }> {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				redirect: 'follow'
			});

			if (!response.ok) {
				return { valid: false };
			}

			// Check first byte - torrent files start with 'd' (bencoded dict)
			const buffer = await response.arrayBuffer();
			const bytes = new Uint8Array(buffer);
			if (bytes.length > 0 && bytes[0] === 0x64) {
				return { valid: true, data: Buffer.from(buffer) };
			}
			return { valid: false };
		} catch {
			return { valid: false };
		}
	}

	/**
	 * Build a magnet link from hash and title.
	 */
	private buildMagnetLink(hash: string, title: string): string {
		// Clean up hash (remove any non-hex characters)
		const cleanHash = hash.replace(/[^a-fA-F0-9]/g, '').toLowerCase();

		// URL-encode the title
		const encodedTitle = encodeURIComponent(title);

		// Build magnet link with common public trackers
		const trackers = [
			'udp://tracker.opentrackr.org:1337/announce',
			'udp://open.stealth.si:80/announce',
			'udp://tracker.torrent.eu.org:451/announce',
			'udp://tracker.bittor.pw:1337/announce',
			'udp://public.popcorn-tracker.org:6969/announce',
			'udp://tracker.dler.org:6969/announce',
			'udp://exodus.desync.com:6969',
			'udp://open.demonii.com:1337/announce'
		];

		const trackerParams = trackers.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('');

		return `magnet:?xt=urn:btih:${cleanHash}&dn=${encodedTitle}${trackerParams}`;
	}

	/**
	 * Resolve URL relative to base.
	 */
	private resolveUrl(path: string, base: string): string {
		// Already absolute
		if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('magnet:')) {
			return path;
		}

		try {
			return new URL(path, base).toString();
		} catch {
			// If base URL is also relative, prepend site link
			const siteLinkVar = this.templateEngine.getVariable('.Config.sitelink');
			const siteLink =
				(typeof siteLinkVar === 'string' ? siteLinkVar : null) ?? this.definition.links[0];
			try {
				return new URL(path, siteLink).toString();
			} catch {
				return siteLink + (path.startsWith('/') ? path : '/' + path);
			}
		}
	}

	/**
	 * Check if a string looks like a URL rather than a CSS selector.
	 * Used to detect when a template-expanded selector is actually a download URL
	 * (e.g., nCore's {{ .Variables.fullDownloadUrl }} expands to "torrents.php?action=download&id=...").
	 */
	private isUrlLikeString(str: string): boolean {
		if (!str || str.length === 0) return false;
		// Absolute URLs
		if (/^https?:\/\//i.test(str)) return true;
		if (str.startsWith('magnet:')) return true;
		// Root-relative paths
		if (str.startsWith('/')) return true;
		// Relative URL paths (e.g., "torrents.php?action=download&id=123")
		if (/^[a-zA-Z0-9_-]+\.[a-zA-Z]{2,5}([?/]|$)/.test(str)) return true;
		return false;
	}

	/**
	 * Extract download variables from a details or search page.
	 * This handles indexers that generate download URLs dynamically (e.g., nCore).
	 */
	async extractDownloadVariables(
		download: DownloadBlock,
		context: DownloadContext,
		headers: Record<string, string>
	): Promise<Record<string, string>> {
		const variables: Record<string, string> = {};

		if (!download.downloadVariables?.length) {
			return variables;
		}

		const fetchFrom = download.downloadVariablesFrom ?? 'details';
		let fetchUrl: string | undefined;

		if (fetchFrom === 'details' && context.releaseDetailsUrl) {
			fetchUrl = context.releaseDetailsUrl;
		} else if (fetchFrom === 'search' && context.baseUrl) {
			// For search page, we don't have the search URL in context
			// This would need additional implementation if needed
			this.log.debug('downloadVariablesFrom: search not yet supported');
			return variables;
		}

		if (!fetchUrl) {
			this.log.debug(
				{
					fetchFrom,
					hasDetailsUrl: !!context.releaseDetailsUrl
				},
				'No URL available for download variable extraction'
			);
			return variables;
		}

		try {
			this.log.debug(
				{
					url: fetchUrl.substring(0, 80),
					headers: Object.keys(headers)
				},
				'Fetching page for download variable extraction'
			);

			const cfResponse = await cloudflareFetch(fetchUrl, {
				method: 'GET',
				headers,
				timeout: 30000,
				encoding: context.encoding
			});

			this.log.debug(
				{
					status: cfResponse.status,
					bodyLength: cfResponse.body.length,
					bodyPreview: cfResponse.body.substring(0, 100)
				},
				'Download variable extraction response'
			);

			const $ = cheerio.load(cfResponse.body);

			for (const variable of download.downloadVariables) {
				const result = this.selectorEngine.selectHtml($, $.root(), variable, false);

				if (result.value) {
					let value = result.value;

					if (variable.filters) {
						value = this.filterEngine.applyFilters(value, variable.filters);
					}

					variables[variable.name] = value;
					this.log.debug(
						{
							name: variable.name,
							value: value.substring(0, 50)
						},
						'Extracted download variable'
					);
				} else {
					this.log.warn(
						{
							name: variable.name,
							selector: variable.selector
						},
						'Download variable selector did not match'
					);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log.error({ error: message }, 'Failed to extract download variables');
		}

		return variables;
	}

	/**
	 * Check if this definition has a download block.
	 */
	hasDownloadBlock(): boolean {
		return !!this.definition.download;
	}

	/**
	 * Check if download needs resolution (has selectors or infohash).
	 */
	needsResolution(): boolean {
		const download = this.definition.download;
		if (!download) return false;

		return !!(download.selectors?.length || download.infohash || download.before);
	}
}

/**
 * Create a new DownloadHandler instance.
 */
export function createDownloadHandler(
	definition: CardigannDefinition,
	templateEngine: TemplateEngine,
	filterEngine: FilterEngine,
	selectorEngine: SelectorEngine
): DownloadHandler {
	return new DownloadHandler(definition, templateEngine, filterEngine, selectorEngine);
}
