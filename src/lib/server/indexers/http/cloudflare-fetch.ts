/**
 * Cloudflare-aware fetch utility.
 *
 * Provides a simple fetch function that automatically falls back to
 * browser-based fetching when Cloudflare protection is detected.
 *
 * This can be used by components that don't have access to IndexerHttp
 * (like AuthManager, DownloadHandler) but still need Cloudflare bypass.
 */

import type { Cookie } from 'playwright-core';
import { isCloudflareProtected } from './CloudflareDetection';
import { captchaSolverSettingsService, getCaptchaSolver } from '#lib/server/captcha/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import { decodeBuffer } from './EncodingUtils';

export interface CloudflareFetchOptions {
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	timeout?: number;
	/** If true, skip browser fallback and just return the CF-protected response */
	skipBrowserFallback?: boolean;
	/** Response encoding (default: UTF-8) */
	encoding?: string;
}

export interface CloudflareFetchResult {
	body: string;
	status: number;
	headers: Headers;
	url: string;
	/** True if the response came from browser fetch */
	usedBrowser: boolean;
}

/**
 * Turn the caller's `Cookie` header into cookies the browser can start with.
 *
 * The plain fetch carries the indexer's stored session, but the browser that
 * takes over on a challenge starts with an empty cookie jar - so a private
 * tracker answers it as an anonymous visitor. A definition that extracts its
 * download URL from a details page then matches its selectors against a login
 * page and reports "selector did not match" for a page it was never served
 * (#663). Everything the caller already has belongs in the browser too.
 */
function cookiesFromHeaders(headers: Record<string, string>, url: string): Cookie[] {
	const header = Object.entries(headers).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
	if (!header) return [];

	const domain = new URL(url).hostname;
	const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
	const cookies: Cookie[] = [];
	for (const pair of header.split(';')) {
		const trimmed = pair.trim();
		const separator = trimmed.indexOf('=');
		if (separator <= 0) continue;
		cookies.push({
			name: trimmed.slice(0, separator),
			value: trimmed.slice(separator + 1),
			domain,
			path: '/',
			expires,
			httpOnly: false,
			secure: true,
			sameSite: 'Lax'
		});
	}
	return cookies;
}

/**
 * Fetch a URL with automatic Cloudflare bypass.
 *
 * First attempts a normal fetch. If Cloudflare is detected and the
 * captcha solver is available, falls back to browser-based fetching with the
 * caller's session cookies, so the browser sees the same authenticated site.
 */
export async function cloudflareFetch(
	url: string,
	options: CloudflareFetchOptions = {}
): Promise<CloudflareFetchResult> {
	const {
		method = 'GET',
		headers = {},
		body,
		timeout = 30000,
		skipBrowserFallback = false,
		encoding = 'UTF-8'
	} = options;

	// Try normal fetch first
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			method,
			headers,
			body,
			signal: controller.signal,
			redirect: 'follow'
		});

		// Get raw buffer and decode with proper encoding
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		const { text: responseBody } = decodeBuffer(buffer, encoding);

		// Check for Cloudflare
		if (isCloudflareProtected(response.status, response.headers, responseBody)) {
			if (skipBrowserFallback) {
				return {
					body: responseBody,
					status: response.status,
					headers: response.headers,
					url: response.url,
					usedBrowser: false
				};
			}

			// Try browser fallback
			const solver = getCaptchaSolver();
			const captchaEnabled = captchaSolverSettingsService.isEnabled();
			if (!captchaEnabled) {
				logger.info(
					{
						url
					},
					'[cloudflareFetch] Cloudflare detected, captcha solver disabled'
				);
			} else if (solver.isAvailable()) {
				const host = new URL(url).hostname;
				logger.info(
					{
						url,
						host
					},
					'[cloudflareFetch] Cloudflare detected, using browser fallback'
				);

				const browserResult = await solver.fetch({
					url,
					method,
					body,
					cookies: cookiesFromHeaders(headers, url),
					timeout: Math.ceil(timeout / 1000)
				});

				if (browserResult.success) {
					logger.info(
						{
							url,
							status: browserResult.status,
							bodyLength: browserResult.body.length
						},
						'[cloudflareFetch] Browser fetch succeeded'
					);

					const responseHeaders = new Headers();
					if (browserResult.headers) {
						for (const [key, value] of Object.entries(browserResult.headers)) {
							if (value !== undefined) {
								responseHeaders.set(key, value);
							}
						}
					}

					return {
						body: browserResult.body,
						status: browserResult.status,
						headers: responseHeaders,
						url: browserResult.url,
						usedBrowser: true
					};
				}

				logger.warn(
					{
						url,
						error: browserResult.error
					},
					'[cloudflareFetch] Browser fetch failed'
				);
			}
		}

		// Return normal response
		return {
			body: responseBody,
			status: response.status,
			headers: response.headers,
			url: response.url,
			usedBrowser: false
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
