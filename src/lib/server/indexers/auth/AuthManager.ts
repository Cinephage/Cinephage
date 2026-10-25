/**
 * Authentication manager for YAML-based indexers.
 * Handles login flows, cookie management, and session verification.
 */

import * as cheerio from 'cheerio';
import type { YamlDefinition, LoginBlock } from '../schema/yamlDefinition';
import { TemplateEngine } from '../engine/TemplateEngine';
import { FilterEngine } from '../engine/FilterEngine';
import { SelectorEngine } from '../engine/SelectorEngine';
import { CookieStore } from './CookieStore';
import { decodeBuffer } from '../http/EncodingUtils';
import { isCloudflareProtected, CloudflareProtectedError } from '../http/CloudflareDetection';
import { captchaSolverSettingsService, getCaptchaSolver } from '#lib/server/captcha/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const authLogger = createChildLogger({ logDomain: 'indexers' as const });

export interface AuthContext {
	indexerId: string;
	baseUrl: string;
	settings: Record<string, unknown>;
	encoding?: string;
}

export interface LoginResult {
	success: boolean;
	cookies: Record<string, string>;
	error?: string;
}

export class AuthManager {
	private definition: YamlDefinition;
	private templateEngine: TemplateEngine;
	private filterEngine: FilterEngine;
	private selectorEngine: SelectorEngine;
	private cookieStore: CookieStore;
	private cookies: Record<string, string> = {};

	constructor(
		definition: YamlDefinition,
		templateEngine: TemplateEngine,
		filterEngine: FilterEngine,
		selectorEngine: SelectorEngine,
		cookieStore: CookieStore
	) {
		this.definition = definition;
		this.templateEngine = templateEngine;
		this.filterEngine = filterEngine;
		this.selectorEngine = selectorEngine;
		this.cookieStore = cookieStore;
	}

	/**
	 * Check if this indexer requires authentication.
	 */
	requiresAuth(): boolean {
		return !!this.definition.login;
	}

	/**
	 * Get current cookies.
	 */
	getCookies(): Record<string, string> {
		return { ...this.cookies };
	}

	/**
	 * Set cookies (from stored session).
	 */
	setCookies(cookies: Record<string, string>): void {
		this.cookies = { ...cookies };
	}

	/**
	 * Load cookies from storage.
	 */
	async loadCookies(context: AuthContext): Promise<boolean> {
		const stored = await this.cookieStore.load(context.indexerId);
		if (stored) {
			this.cookies = stored.cookies;
			return true;
		}
		return false;
	}

	/**
	 * Save cookies to storage.
	 */
	async saveCookies(context: AuthContext): Promise<void> {
		await this.cookieStore.save(context.indexerId, this.cookies, CookieStore.getDefaultExpiry());
	}

	/**
	 * Refresh cookie expiration after successful request.
	 * This keeps the session alive by extending the expiration date.
	 */
	async refreshCookieExpiration(context: AuthContext): Promise<void> {
		if (Object.keys(this.cookies).length === 0) {
			return;
		}

		// Reload current cookies from storage to preserve any expiration data
		const stored = await this.cookieStore.load(context.indexerId);
		if (stored) {
			// Merge current cookies with stored expirations
			this.cookies = { ...stored.cookies, ...this.cookies };
		}

		// Save with refreshed expiration (12 days from Prowlarr's approach, or 30 days default)
		const newExpiry = CookieStore.getDefaultExpiry();
		await this.cookieStore.save(context.indexerId, this.cookies, newExpiry);
	}

	/**
	 * Clear stored cookies.
	 */
	async clearCookies(context: AuthContext): Promise<void> {
		this.cookies = {};
		await this.cookieStore.clear(context.indexerId);
	}

	/**
	 * Check if login is needed based on response.
	 */
	checkLoginNeeded(response: Response, content: string): boolean {
		const login = this.definition.login;
		if (!login) return false;

		// Check for HTTP error
		if (!response.ok) {
			return true;
		}

		// Check for redirect to different domain
		if (response.redirected) {
			const originalHost = new URL(this.definition.links[0]).host;
			const redirectHost = new URL(response.url).host;
			if (originalHost !== redirectHost) {
				return true;
			}
		}

		// Check test selector (element that should exist when logged in)
		if (login.test?.selector) {
			const contentType = response.headers.get('content-type') ?? '';
			if (contentType.includes('text/html')) {
				const $ = cheerio.load(content);
				const testElement = $(login.test.selector);
				if (testElement.length === 0) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Perform login based on the definition's login method.
	 */
	async login(context: AuthContext): Promise<LoginResult> {
		const login = this.definition.login;
		if (!login) {
			return { success: true, cookies: {} };
		}

		// Set up template variables
		this.templateEngine.setSiteLink(context.baseUrl);
		this.templateEngine.setConfig(context.settings);

		const method = login.method?.toLowerCase() ?? 'post';

		try {
			switch (method) {
				case 'post':
					return await this.loginPost(login, context);
				case 'form':
					return await this.loginForm(login, context);
				case 'cookie':
					return this.loginCookie(login, context);
				case 'get':
					return await this.loginGet(login, context);
				case 'oneurl':
					return await this.loginOneUrl(login, context);
				case 'basic':
					return this.loginBasic(login, context);
				case 'apikey':
					return this.loginApiKey(login, context);
				case 'none':
					return { success: true, cookies: {} };
				default:
					return { success: false, cookies: {}, error: `Unknown login method: ${method}` };
			}
		} catch (error) {
			return {
				success: false,
				cookies: {},
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Login via direct POST request.
	 */
	private async loginPost(login: LoginBlock, context: AuthContext): Promise<LoginResult> {
		const loginUrl = this.resolveUrl(
			this.templateEngine.expand(login.path ?? '/login'),
			context.baseUrl
		);

		// Build form data
		const formData = new URLSearchParams();
		if (login.inputs) {
			for (const [key, value] of Object.entries(login.inputs)) {
				formData.append(key, this.templateEngine.expand(value));
			}
		}

		// Prepare cookies
		let requestCookies = { ...this.cookies };
		if (login.cookies) {
			const loginCookies = CookieStore.parseCookieHeader(login.cookies.join('; '));
			requestCookies = CookieStore.mergeCookies(requestCookies, loginCookies);
		}

		// Build headers
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
			Referer: context.baseUrl
		};

		if (login.headers) {
			for (const [key, values] of Object.entries(login.headers)) {
				headers[key] = this.templateEngine.expand(values[0]);
			}
		}

		const result = await this.requestWithCloudflareFallback(loginUrl, {
			method: 'POST',
			headers,
			body: formData,
			requestCookies,
			encoding: context.encoding
		});

		this.cookies = result.cookies;

		const error = this.checkLoginError(result.status, result.content, login);
		if (error) {
			return { success: false, cookies: this.cookies, error };
		}

		return { success: true, cookies: this.cookies };
	}

	/**
	 * Login via form (fetch form page, parse, submit).
	 */
	private async loginForm(login: LoginBlock, context: AuthContext): Promise<LoginResult> {
		const loginUrl = this.resolveUrl(
			this.templateEngine.expand(login.path ?? '/login'),
			context.baseUrl
		);

		// Prepare initial cookies
		let requestCookies = { ...this.cookies };
		if (login.cookies) {
			const loginCookies = CookieStore.parseCookieHeader(login.cookies.join('; '));
			requestCookies = CookieStore.mergeCookies(requestCookies, loginCookies);
		}

		// Fetch login page (Cloudflare-aware: falls back to browser when challenged)
		const pageResult = await this.requestWithCloudflareFallback(loginUrl, {
			method: 'GET',
			headers: { Referer: context.baseUrl },
			requestCookies,
			encoding: context.encoding
		});

		this.cookies = pageResult.cookies;
		const pageContent = pageResult.content;
		const $ = cheerio.load(pageContent);

		// Find form
		const formSelector = login.form ?? 'form';
		const form = $(formSelector);
		if (form.length === 0) {
			return { success: false, cookies: this.cookies, error: `Form not found: ${formSelector}` };
		}

		// Collect form inputs
		const formData = new URLSearchParams();
		form.find('input').each((_, el) => {
			const input = $(el);
			const name = input.attr('name');
			const type = input.attr('type')?.toLowerCase();
			const disabled = input.attr('disabled') !== undefined;

			if (!name || disabled) return;

			// Skip unchecked checkboxes/radios
			if ((type === 'checkbox' || type === 'radio') && !input.is(':checked')) {
				return;
			}

			const value = input.attr('value') ?? '';
			formData.append(name, value);
		});

		// Override with definition inputs
		if (login.inputs) {
			for (const [key, value] of Object.entries(login.inputs)) {
				let inputKey = key;

				// If selectors mode, find input by selector
				if (login.selectors) {
					const inputEl = $(key);
					if (inputEl.length > 0) {
						inputKey = inputEl.attr('name') ?? key;
					}
				}

				formData.set(inputKey, this.templateEngine.expand(value));
			}
		}

		// Add selector inputs (values from page)
		if (login.selectorinputs) {
			for (const [key, selector] of Object.entries(login.selectorinputs)) {
				try {
					const result = this.selectorEngine.selectHtml($, $.root(), selector, !selector.optional);
					if (result.value !== null) {
						formData.set(key, result.value);
					}
				} catch (error) {
					if (!selector.optional) {
						return {
							success: false,
							cookies: this.cookies,
							error: `Selector input ${key} failed: ${error}`
						};
					}
				}
			}
		}

		// Determine submit URL
		let submitUrl = form.attr('action') ?? '';
		if (login.submitpath) {
			submitUrl = login.submitpath;
		}
		submitUrl = this.resolveUrl(this.templateEngine.expand(submitUrl), loginUrl);

		// Add get selector inputs to URL
		if (login.getselectorinputs) {
			const url = new URL(submitUrl);
			for (const [key, selector] of Object.entries(login.getselectorinputs)) {
				try {
					const result = this.selectorEngine.selectHtml($, $.root(), selector, !selector.optional);
					if (result.value !== null) {
						url.searchParams.set(key, result.value);
					}
				} catch {
					// Optional, skip on error
				}
			}
			submitUrl = url.toString();
		}

		// Build headers for submit
		const submitHeaders: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
			Referer: loginUrl
		};

		if (login.headers) {
			for (const [key, values] of Object.entries(login.headers)) {
				submitHeaders[key] = this.templateEngine.expand(values[0]);
			}
		}

		// Submit form (Cloudflare-aware: the browser fallback rewrites the initial GET
		// into a POST and captures session cookies from the response).
		const submitResult = await this.requestWithCloudflareFallback(submitUrl, {
			method: 'POST',
			headers: submitHeaders,
			body: formData,
			requestCookies: this.cookies,
			encoding: context.encoding
		});

		this.cookies = submitResult.cookies;

		// Check for errors - decode with proper encoding
		const error = this.checkLoginError(submitResult.status, submitResult.content, login);
		if (error) {
			return { success: false, cookies: this.cookies, error };
		}

		return { success: true, cookies: this.cookies };
	}

	/**
	 * Login via user-provided cookies.
	 * Supports either:
	 * 1. A single 'cookie' setting with the full cookie string
	 * 2. Separate fields (e.g., 'uid' and 'pass' for SceneTime-style trackers)
	 */
	private loginCookie(login: LoginBlock, context: AuthContext): LoginResult {
		// First try the combined 'cookie' setting (backward compatible)
		const cookieValue = context.settings['cookie'] as string | undefined;
		if (cookieValue) {
			this.cookies = CookieStore.parseCookieHeader(cookieValue);
			return { success: true, cookies: this.cookies };
		}

		// Try to build cookie from separate uid/pass fields (SceneTime-style)
		const uid = context.settings['uid'] as string | undefined;
		const pass = context.settings['pass'] as string | undefined;
		if (uid && pass) {
			this.cookies = { uid, pass };
			return { success: true, cookies: this.cookies };
		}

		// Check if there are any cookie-like settings we can use
		// Look for settings that might be cookie values
		const cookieSettings: Record<string, string> = {};
		for (const [key, value] of Object.entries(context.settings)) {
			// Skip non-string values and special keys
			if (typeof value !== 'string' || !value) continue;
			if (['freeleech', 'sort', 'baseUrl'].includes(key)) continue;
			// Add potential cookie values
			cookieSettings[key] = value;
		}

		if (Object.keys(cookieSettings).length > 0) {
			this.cookies = cookieSettings;
			return { success: true, cookies: this.cookies };
		}

		return {
			success: false,
			cookies: {},
			error: 'No cookie credentials provided. Please provide uid and pass values.'
		};
	}

	/**
	 * Login via GET request.
	 */
	private async loginGet(login: LoginBlock, context: AuthContext): Promise<LoginResult> {
		const url = new URL(
			this.resolveUrl(this.templateEngine.expand(login.path ?? '/login'), context.baseUrl)
		);

		// Add inputs as query parameters
		if (login.inputs) {
			for (const [key, value] of Object.entries(login.inputs)) {
				url.searchParams.set(key, this.templateEngine.expand(value));
			}
		}

		// Build headers
		const headers: Record<string, string> = {
			Referer: context.baseUrl
		};

		if (login.headers) {
			for (const [key, values] of Object.entries(login.headers)) {
				headers[key] = this.templateEngine.expand(values[0]);
			}
		}

		// Execute request (Cloudflare-aware)
		const result = await this.requestWithCloudflareFallback(url.toString(), {
			method: 'GET',
			headers,
			requestCookies: this.cookies,
			encoding: context.encoding
		});

		this.cookies = result.cookies;

		// Check for errors - decode with proper encoding
		const error = this.checkLoginError(result.status, result.content, login);
		if (error) {
			return { success: false, cookies: this.cookies, error };
		}

		return { success: true, cookies: this.cookies };
	}

	/**
	 * Login via one URL (passkey in URL).
	 */
	private async loginOneUrl(login: LoginBlock, context: AuthContext): Promise<LoginResult> {
		// Get oneurl from inputs
		const oneUrl = login.inputs?.['oneurl'];
		if (!oneUrl) {
			return { success: false, cookies: {}, error: 'oneurl input not defined' };
		}

		const expandedUrl = this.templateEngine.expand(oneUrl);
		const url = this.resolveUrl(
			this.templateEngine.expand(login.path ?? '') + expandedUrl,
			context.baseUrl
		);

		// Build headers
		const headers: Record<string, string> = {
			Referer: context.baseUrl
		};

		if (login.headers) {
			for (const [key, values] of Object.entries(login.headers)) {
				headers[key] = this.templateEngine.expand(values[0]);
			}
		}

		// Execute request (Cloudflare-aware)
		const result = await this.requestWithCloudflareFallback(url, {
			method: 'GET',
			headers,
			requestCookies: this.cookies,
			encoding: context.encoding
		});

		this.cookies = result.cookies;

		// Check for errors - decode with proper encoding
		const error = this.checkLoginError(result.status, result.content, login);
		if (error) {
			return { success: false, cookies: this.cookies, error };
		}

		return { success: true, cookies: this.cookies };
	}

	/**
	 * Login via HTTP Basic Authentication.
	 * Stores the Authorization header value for subsequent requests.
	 */
	private loginBasic(login: LoginBlock, context: AuthContext): LoginResult {
		const username = context.settings['username'] as string | undefined;
		const password = context.settings['password'] as string | undefined;

		if (!username) {
			return { success: false, cookies: {}, error: 'Username not provided in settings' };
		}

		// Generate Basic auth header value
		const credentials = `${username}:${password ?? ''}`;
		const encoded = Buffer.from(credentials).toString('base64');
		const authHeader = `Basic ${encoded}`;

		// Store auth header in a special way (will be used by HttpClient)
		// We use a special cookie key to signal basic auth
		this.cookies = {
			__auth_type: 'basic',
			__auth_header: authHeader
		};

		return { success: true, cookies: this.cookies };
	}

	/**
	 * Login via API key in headers or query params.
	 * For indexers that use API keys instead of session cookies.
	 */
	private loginApiKey(login: LoginBlock, context: AuthContext): LoginResult {
		const apiKey = context.settings['apikey'] as string | undefined;

		if (!apiKey) {
			return { success: false, cookies: {}, error: 'API key not provided in settings' };
		}

		// Determine how to pass the API key
		// Check if there's a custom header name in login.headers
		let headerName = 'X-Api-Key'; // Default header name
		let headerValue = apiKey;

		if (login.inputs) {
			// Check for custom apikey input configuration
			for (const [key, value] of Object.entries(login.inputs)) {
				const expanded = this.templateEngine.expand(value);
				if (key.toLowerCase() === 'header') {
					headerName = expanded;
				} else if (key.toLowerCase() === 'value' || key.toLowerCase() === 'apikey') {
					headerValue = expanded;
				}
			}
		}

		// Store API key auth info in special cookies (will be used by HttpClient)
		this.cookies = {
			__auth_type: 'apikey',
			__auth_header_name: headerName,
			__auth_header_value: headerValue
		};

		return { success: true, cookies: this.cookies };
	}

	/**
	 * Check for login errors in response.
	 */
	private checkLoginError(status: number, content: string, login: LoginBlock): string | null {
		// Check HTTP status
		if (status === 401) {
			return 'Unauthorized (401)';
		}

		// Check error selectors
		if (login.error) {
			const $ = cheerio.load(content);

			for (const errorBlock of login.error) {
				if (errorBlock.selector) {
					const errorEl = $(errorBlock.selector);
					if (errorEl.length > 0) {
						let errorMessage = errorEl.text().trim();

						// Use custom message selector if provided
						if (errorBlock.message) {
							try {
								const result = this.selectorEngine.selectHtml(
									$,
									$.root(),
									errorBlock.message,
									false
								);
								if (result.value) {
									errorMessage = result.value;
								}
							} catch {
								// Use default error text
							}
						}

						return errorMessage || 'Login error';
					}
				}
			}
		}

		return null;
	}

	/**
	 * Perform a login request with Cloudflare awareness.
	 *
	 * Tries a plain fetch first (with manual redirect following so session cookies
	 * from 302 responses are captured). If the response looks like a Cloudflare
	 * challenge and the captcha solver (Camoufox browser) is available, retries
	 * through the browser — which both passes the challenge and returns the
	 * session cookies set by the site.
	 */
	private async requestWithCloudflareFallback(
		url: string,
		options: {
			method: 'GET' | 'POST';
			headers?: Record<string, string>;
			body?: URLSearchParams | string;
			requestCookies?: Record<string, string>;
			encoding?: string;
			maxRedirects?: number;
		}
	): Promise<{ status: number; content: string; cookies: Record<string, string>; url: string }> {
		const { maxRedirects = 5 } = options;
		const encoding = options.encoding ?? 'UTF-8';

		let currentUrl = url;
		let currentCookies = { ...(options.requestCookies ?? {}) };
		let requestMethod: 'GET' | 'POST' = options.method;
		let requestBody: URLSearchParams | string | undefined = options.body;

		for (let redirects = 0; redirects <= maxRedirects; redirects++) {
			const headers = { ...(options.headers ?? {}) };
			if (Object.keys(currentCookies).length > 0) {
				headers['Cookie'] = CookieStore.buildCookieHeader(currentCookies);
			}

			const response = await fetch(currentUrl, {
				method: requestMethod,
				headers,
				body: requestBody,
				redirect: 'manual'
			});

			const arrayBuffer = await response.arrayBuffer();
			const { text: content } = decodeBuffer(Buffer.from(arrayBuffer), encoding);
			const status = response.status;

			const extracted = CookieStore.extractCookiesFromResponse(response);
			currentCookies = CookieStore.mergeCookies(currentCookies, extracted.cookies);

			// Cloudflare challenge → browser fallback
			if (isCloudflareProtected(status, response.headers, content)) {
				const host = new URL(currentUrl).hostname;
				const solver = getCaptchaSolver();
				const captchaEnabled = captchaSolverSettingsService.isEnabled();

				if (!captchaEnabled) {
					authLogger.info(
						{ host, url: currentUrl },
						'[AuthManager] Cloudflare detected, captcha solver disabled'
					);
					throw new CloudflareProtectedError(host, status);
				}

				if (solver.isAvailable()) {
					authLogger.info(
						{ host, url: currentUrl },
						'[AuthManager] Cloudflare detected, fetching through browser'
					);

					const browserResult = await solver.fetch({
						url: currentUrl,
						method: requestMethod,
						body: typeof requestBody === 'string' ? requestBody : requestBody?.toString(),
						timeout: 60,
						cookies: CookieStore.toPlaywrightCookies(currentCookies, host)
					});

					if (browserResult.success) {
						const browserCookies = CookieStore.toCookieRecord(browserResult.cookies ?? []);
						currentCookies = CookieStore.mergeCookies(currentCookies, browserCookies);
						authLogger.info(
							{
								host,
								status: browserResult.status,
								cookieCount: Object.keys(browserCookies).length
							},
							'[AuthManager] Browser login request succeeded'
						);
						return {
							status: browserResult.status,
							content: browserResult.body,
							cookies: currentCookies,
							url: browserResult.url
						};
					}

					authLogger.warn(
						{ host, error: browserResult.error },
						'[AuthManager] Browser login request failed'
					);
				}

				// Report the challenge explicitly instead of surfacing a misleading
				// "Form not found" error downstream.
				throw new CloudflareProtectedError(host, status);
			}

			// Follow redirects manually to capture Set-Cookie from 302 responses.
			if (status >= 300 && status < 400) {
				const location = response.headers.get('location');
				if (location) {
					currentUrl = this.resolveUrl(location, currentUrl);
					requestMethod = 'GET';
					requestBody = undefined;
					continue;
				}
			}

			return { status, content, cookies: currentCookies, url: response.url };
		}

		throw new Error(`Too many redirects during login request to ${url}`);
	}

	/**
	 * Resolve URL relative to base.
	 */
	private resolveUrl(path: string, base: string): string {
		if (path.startsWith('http://') || path.startsWith('https://')) {
			return path;
		}
		try {
			return new URL(path, base).toString();
		} catch {
			return base + (path.startsWith('/') ? path : '/' + path);
		}
	}
}

/**
 * Create a new AuthManager instance.
 */
export function createAuthManager(
	definition: YamlDefinition,
	templateEngine: TemplateEngine,
	filterEngine: FilterEngine,
	selectorEngine: SelectorEngine,
	cookieStore: CookieStore
): AuthManager {
	return new AuthManager(definition, templateEngine, filterEngine, selectorEngine, cookieStore);
}
