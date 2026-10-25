/**
 * Camoufox Challenge Solver
 *
 * Challenge solving logic using Camoufox anti-detect browser.
 * Camoufox handles stealth and fingerprinting internally at the C++ level.
 */

import type { Page } from 'playwright-core';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import type {
	ChallengeType,
	SolveResult,
	SolveRequest,
	BrowserFetchRequest,
	BrowserFetchResult
} from '../types';
import { getCamoufoxManager, type ManagedBrowser } from './CamoufoxManager';
import { detectChallengeFromPage } from '../detection/ChallengeDetector';
import { attemptChallengeCheckboxClick } from './CloudflareClickSolver';

/**
 * Challenge title patterns that indicate an ongoing challenge.
 * Used to detect when challenge is still active vs completed.
 */
const CHALLENGE_TITLE_PATTERNS = [
	'Just a moment',
	'Checking',
	'Please wait',
	'DDoS-Guard',
	// Cloudflare challenge titles in other languages
	'Un instant', // French
	'Einen Moment', // German
	'Un momento', // Spanish/Italian
	'Aguarde', // Portuguese
	'しばらくお待ち', // Japanese
	'잠시만', // Korean
	'请稍候' // Chinese
];

/**
 * Cloudflare shows an intermediate "Loading https://<url>" redirect page AFTER
 * the challenge is passed but BEFORE the real content loads. Treat it as still
 * in-progress so we don't capture the redirect page as the result.
 */
const REDIRECT_TITLE_RE = /^Loading https?:\/\//i;

function isInterstitialTitle(title: string): boolean {
	return (
		CHALLENGE_TITLE_PATTERNS.some((pattern) => title.includes(pattern)) ||
		REDIRECT_TITLE_RE.test(title)
	);
}

/** Body markers that indicate the returned HTML is still a Cloudflare challenge page. */
const CHALLENGE_BODY_MARKERS = [
	'<title>Just a moment',
	'challenge-platform',
	'cf-browser-verification',
	'cf_chl_opt',
	'window._cf_chl_opt'
];

function bodyLooksLikeChallenge(body: string): boolean {
	if (!body) return false;
	return CHALLENGE_BODY_MARKERS.some((marker) => body.includes(marker));
}

/** Best-effort wait for the page to settle after the challenge hands off. */
async function settlePage(page: Page): Promise<void> {
	try {
		await page.waitForLoadState('networkidle', { timeout: 5000 });
	} catch {
		// networkidle may never fire on busy pages — best effort only.
	}
}

/**
 * Wait for a Cloudflare challenge to complete.
 *
 * Returns true only once the page has moved past both the challenge and the
 * post-challenge "Loading…" redirect to a real page. A present `cf_clearance`
 * cookie is treated as success ONLY as a last resort after the timeout, because
 * Cloudflare sets it mid-challenge (observed on 1337x: cf_clearance appears while
 * the page still shows "Just a moment…"), so cookie-presence alone is a false
 * positive for "solved".
 */
async function waitForChallengeComplete(page: Page, timeout = 30000): Promise<boolean> {
	const startTime = Date.now();
	let lastClickAttempt = 0;

	while (Date.now() - startTime < timeout) {
		if (page.isClosed()) {
			// The browser was closed out from under the solve (caller abort or
			// reaper); stop spinning instead of burning the budget holding a slot.
			logger.debug('[CamoufoxSolver] Page closed during challenge wait; stopping early');
			return false;
		}
		try {
			const title = await page.title();

			if (!isInterstitialTitle(title)) {
				// Reached the real page — let it settle, then we're done.
				await settlePage(page);
				return true;
			}

			// Still on the interstitial. Managed/Turnstile challenges need a real
			// trusted click on the checkbox (inside a cross-origin closed shadow DOM),
			// handled by the click solver. Throttle attempts.
			if (Date.now() - lastClickAttempt > 3000) {
				lastClickAttempt = Date.now();
				await attemptChallengeCheckboxClick(page).catch(() => false);
			}
		} catch {
			// Navigation can destroy the execution context during hand-off — expected.
			// Wait briefly and re-loop; the title check confirms the real page.
			await new Promise((r) => setTimeout(r, 500));
		}

		// Wait before next check
		await new Promise((r) => setTimeout(r, 500));
	}

	// Timed out without the title clearing. Last resort: a present cf_clearance
	// cookie lets solve() cache usable cookies even if the page didn't fully load.
	try {
		const cookies = await page.context().cookies();
		if (cookies.some((c) => c.name === 'cf_clearance')) {
			logger.debug('[CamoufoxSolver] Timed out but cf_clearance present; treating as solved');
			return true;
		}
	} catch {
		// Context unavailable — fall through to failure.
	}

	return false;
}

/**
 * Resource types blocked to cut browser memory/bandwidth during solving.
 * Images, media and fonts are never needed to clear a challenge, and rendering
 * them is a large part of a headless Firefox's RSS.
 */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

/**
 * Install a single request-interception handler that (optionally) blocks heavy
 * media resources and (optionally) rewrites the initial GET navigation into a POST.
 */
async function setupPageInterception(
	page: Page,
	opts: {
		blockMedia: boolean;
		post?: { url: string; body: string; contentType?: string };
	}
): Promise<void> {
	if (!opts.blockMedia && !opts.post) {
		return;
	}

	await page.route('**/*', async (route, req) => {
		if (opts.blockMedia && BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
			await route.abort().catch(() => {});
			return;
		}

		if (opts.post && req.url() === opts.post.url && req.method() === 'GET') {
			await route
				.continue({
					method: 'POST',
					postData: opts.post.body,
					headers: {
						...req.headers(),
						'Content-Type': opts.post.contentType || 'application/x-www-form-urlencoded'
					}
				})
				.catch(() => {});
			return;
		}

		await route.continue().catch(() => {});
	});
}

/**
 * Wire an AbortSignal to a managed browser so a cancelled/timed-out caller
 * promptly closes the browser (mirrors Byparr's single-timeout-budget model).
 * Returns a cleanup function to detach the listener.
 */
function attachAbort(
	signal: AbortSignal | undefined,
	manager: ReturnType<typeof getCamoufoxManager>,
	managed: ManagedBrowser
): () => void {
	if (!signal) {
		return () => {};
	}
	const onAbort = () => {
		void manager.closeBrowser(managed);
	};
	signal.addEventListener('abort', onAbort, { once: true });
	return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Failure kinds that justify a second, interactive (shadow-unlock addon) attempt.
 * Everything else (launch failures, aborts, no response) is terminal for the
 * current budget and must not trigger a relaunch.
 */
function isInteractiveFallbackCandidate(error?: string): boolean {
	if (!error) return false;
	return (
		error.includes('Challenge not solved within timeout') ||
		error.includes('challenge page returned')
	);
}

/** Phase 1 (passive) wait budget. Clean fingerprints clear in ~5-15s live. */
const PASSIVE_PHASE_BUDGET_MS = 25_000;

/**
 * Solve a challenge for the given URL using Camoufox
 *
 * Two-phase strategy (live-verified against rutracker.org, issue #228):
 * 1. Passive attempt WITHOUT the shadow-unlock addon — its MAIN-world
 *    attachShadow patch is detected by Cloudflare Turnstile, which then serves
 *    an unwinnable challenge loop even when a clean fingerprint would auto-clear.
 * 2. Only if still challenged with budget remaining: retry WITH the addon so the
 *    ClickSolver can handle genuinely interactive Turnstile checkboxes.
 */
export async function solveChallenge(
	request: SolveRequest,
	config: { headless: boolean; timeoutSeconds: number; blockMedia?: boolean }
): Promise<SolveResult> {
	const startTime = Date.now();
	const camoufoxManager = getCamoufoxManager();

	if (request.signal?.aborted) {
		return createErrorResult('Aborted before start', startTime);
	}

	const timeout = (request.timeout || config.timeoutSeconds) * 1000;

	let result = await runSolveAttempt(request, config, camoufoxManager, {
		startTime,
		timeout,
		shadowUnlockAddon: false,
		waitCapMs: PASSIVE_PHASE_BUDGET_MS
	});

	if (
		isInteractiveFallbackCandidate(result.error) &&
		!request.signal?.aborted &&
		timeout - (Date.now() - startTime) > 10_000
	) {
		logger.info('[CamoufoxSolver] Challenge persists passively; retrying with shadow-unlock addon');
		result = await runSolveAttempt(request, config, camoufoxManager, {
			startTime,
			timeout,
			shadowUnlockAddon: true
		});
	}

	return result;
}

async function runSolveAttempt(
	request: SolveRequest,
	config: { headless: boolean; timeoutSeconds: number; blockMedia?: boolean },
	camoufoxManager: ReturnType<typeof getCamoufoxManager>,
	opts: {
		startTime: number;
		timeout: number;
		shadowUnlockAddon: boolean;
		waitCapMs?: number;
	}
): Promise<SolveResult> {
	const { startTime, timeout } = opts;
	let managed: ManagedBrowser | null = null;
	let detachAbort: () => void = () => {};

	try {
		// Extract domain from URL
		const url = new URL(request.url);
		const domain = url.hostname;

		// Create browser
		managed = await camoufoxManager.createBrowserForDomain(domain, {
			headless: config.headless,
			proxy: request.proxy,
			acquireTimeoutMs: timeout,
			signal: request.signal ?? undefined,
			shadowUnlockAddon: opts.shadowUnlockAddon
		});

		detachAbort = attachAbort(request.signal, camoufoxManager, managed);

		const { page, context } = managed;

		await setupPageInterception(page, { blockMedia: config.blockMedia ?? false });

		// Add any provided cookies
		if (request.cookies && request.cookies.length > 0) {
			await camoufoxManager.addCookies(context, request.cookies);
		}

		// Navigate to the URL
		logger.debug({ url: request.url }, '[CamoufoxSolver] Navigating to URL');

		const response = await page.goto(request.url, {
			timeout: Math.min(timeout, 30000),
			waitUntil: 'domcontentloaded'
		});

		if (!response) {
			return createErrorResult('No response received', startTime);
		}

		// Check for challenge using the centralized detector
		const detectionResult = await detectChallengeFromPage(page);
		const { detected, type: challengeType } = detectionResult;

		// Get the actual user agent from the page
		const userAgent = await page
			.evaluate(() => navigator.userAgent)
			.catch(
				() => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'
			);

		// If no challenge detected, we're done
		if (!detected) {
			logger.debug('[CamoufoxSolver] No challenge detected');
			const cookies = await camoufoxManager.extractCookies(context, [request.url]);
			return {
				success: true,
				cookies,
				userAgent,
				solveTimeMs: Date.now() - startTime,
				challengeType: 'unknown',
				response: {
					url: page.url(),
					status: response.status()
				}
			};
		}

		logger.debug(
			{
				type: challengeType,
				confidence: detectionResult.confidence
			},
			'[CamoufoxSolver] Challenge detected'
		);

		// Wait for challenge to complete
		// Camoufox + humanize handles most of this automatically
		const waitBudget = opts.waitCapMs
			? Math.min(timeout - (Date.now() - startTime), opts.waitCapMs)
			: timeout - (Date.now() - startTime);
		const solved = await waitForChallengeComplete(page, waitBudget);

		if (solved) {
			// Get final cookies
			const cookies = await camoufoxManager.extractCookies(context);

			logger.info(
				{
					type: challengeType,
					timeMs: Date.now() - startTime
				},
				'[CamoufoxSolver] Challenge solved'
			);

			return {
				success: true,
				cookies,
				userAgent,
				solveTimeMs: Date.now() - startTime,
				challengeType,
				response: {
					url: page.url(),
					status: 200
				}
			};
		}

		// Check if we got cookies anyway
		const finalCookies = await camoufoxManager.extractCookies(context, [request.url]);
		const hasClearance = finalCookies.some((c) => c.name === 'cf_clearance');

		if (hasClearance) {
			return {
				success: true,
				cookies: finalCookies,
				userAgent,
				solveTimeMs: Date.now() - startTime,
				challengeType
			};
		}

		return createErrorResult('Challenge not solved within timeout', startTime, challengeType);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error({ err: error }, '[CamoufoxSolver] Error solving challenge');
		return createErrorResult(errorMessage, startTime);
	} finally {
		detachAbort();
		// Always close the browser
		if (managed) {
			await camoufoxManager.closeBrowser(managed);
		}
	}
}

/**
 * Create an error result
 */
function createErrorResult(
	error: string,
	startTime: number,
	challengeType: ChallengeType = 'unknown'
): SolveResult {
	return {
		success: false,
		cookies: [],
		userAgent: '',
		solveTimeMs: Date.now() - startTime,
		challengeType,
		error
	};
}

/**
 * Test if a URL has a challenge without solving
 */
export async function testForChallenge(
	url: string,
	config: { headless: boolean; blockMedia?: boolean }
): Promise<{ hasChallenge: boolean; type: ChallengeType; confidence: number }> {
	const camoufoxManager = getCamoufoxManager();
	let managed: ManagedBrowser | null = null;

	try {
		const domain = new URL(url).hostname;
		managed = await camoufoxManager.createBrowserForDomain(domain, {
			headless: config.headless,
			acquireTimeoutMs: 30000
		});

		await setupPageInterception(managed.page, { blockMedia: config.blockMedia ?? false });

		const response = await managed.page.goto(url, {
			timeout: 15000,
			waitUntil: 'domcontentloaded'
		});

		if (!response) {
			return { hasChallenge: false, type: 'unknown', confidence: 0 };
		}

		// Use centralized detector
		const result = await detectChallengeFromPage(managed.page);
		return {
			hasChallenge: result.detected,
			type: result.type,
			confidence: result.confidence
		};
	} catch (error) {
		logger.warn(
			{
				url,
				err: error
			},
			'[CamoufoxSolver] Error testing for challenge'
		);
		return { hasChallenge: false, type: 'unknown', confidence: 0 };
	} finally {
		if (managed) {
			await camoufoxManager.closeBrowser(managed);
		}
	}
}

/**
 * Fetch a page through Camoufox browser.
 * This bypasses TLS/JA3 fingerprinting issues that prevent Node.js fetch
 * from accessing Cloudflare-protected sites even with valid cookies.
 *
 * Two-phase strategy (live-verified against rutracker.org, issue #228):
 * 1. Passive attempt WITHOUT the shadow-unlock addon — its MAIN-world
 *    attachShadow patch is detected by Cloudflare Turnstile, which then serves
 *    an unwinnable challenge loop even when a clean fingerprint would auto-clear.
 * 2. Only if still challenged with budget remaining: retry WITH the addon so the
 *    ClickSolver can handle genuinely interactive Turnstile checkboxes.
 */
export async function browserFetch(
	request: BrowserFetchRequest,
	config: { headless: boolean; timeoutSeconds: number; blockMedia?: boolean }
): Promise<BrowserFetchResult> {
	const startTime = Date.now();
	const camoufoxManager = getCamoufoxManager();

	if (request.signal?.aborted) {
		return {
			success: false,
			body: '',
			url: request.url,
			status: 0,
			headers: {},
			cookies: [],
			userAgent: '',
			error: 'Aborted before start',
			timeMs: Date.now() - startTime
		};
	}

	const timeout = (request.timeout || config.timeoutSeconds) * 1000;

	let result = await runBrowserFetchAttempt(request, config, camoufoxManager, {
		startTime,
		timeout,
		shadowUnlockAddon: false,
		waitCapMs: PASSIVE_PHASE_BUDGET_MS
	});

	if (
		isInteractiveFallbackCandidate(result.error) &&
		!request.signal?.aborted &&
		timeout - (Date.now() - startTime) > 10_000
	) {
		logger.info('[CamoufoxSolver] Challenge persists passively; retrying with shadow-unlock addon');
		result = await runBrowserFetchAttempt(request, config, camoufoxManager, {
			startTime,
			timeout,
			shadowUnlockAddon: true
		});
	}

	return result;
}

async function runBrowserFetchAttempt(
	request: BrowserFetchRequest,
	config: { headless: boolean; timeoutSeconds: number; blockMedia?: boolean },
	camoufoxManager: ReturnType<typeof getCamoufoxManager>,
	opts: {
		startTime: number;
		timeout: number;
		shadowUnlockAddon: boolean;
		waitCapMs?: number;
	}
): Promise<BrowserFetchResult> {
	const { startTime, timeout } = opts;
	let managed: ManagedBrowser | null = null;
	let detachAbort: () => void = () => {};

	try {
		const domain = new URL(request.url).hostname;

		managed = await camoufoxManager.createBrowserForDomain(domain, {
			headless: config.headless,
			proxy: request.proxy,
			acquireTimeoutMs: timeout,
			signal: request.signal ?? undefined,
			shadowUnlockAddon: opts.shadowUnlockAddon
		});

		detachAbort = attachAbort(request.signal, camoufoxManager, managed);

		const { page, context } = managed;

		// Block heavy media, and rewrite the initial GET into a POST when needed.
		await setupPageInterception(page, {
			blockMedia: config.blockMedia ?? false,
			post:
				request.method === 'POST' && request.body
					? { url: request.url, body: request.body, contentType: request.contentType }
					: undefined
		});

		// Inject any pre-existing session cookies (e.g. tracker auth cookies stored
		// by AuthManager) so the browser request is authenticated from the start.
		if (request.cookies && request.cookies.length > 0) {
			await camoufoxManager.addCookies(context, request.cookies);
		}

		// Deep links (e.g. /search/…) get a much stricter Cloudflare challenge than
		// the site root and frequently never clear on their own. Warming up on the
		// origin root first — the way a real user lands on the homepage — establishes
		// a domain-wide cf_clearance, after which the deep link clears in ~2s in the
		// same browser session. browserFetch is only ever called under CF protection,
		// so this warm-up is always appropriate here.
		const target = new URL(request.url);
		const isDeepLink = target.pathname !== '/' || target.search !== '';
		const remaining = () => timeout - (Date.now() - startTime);

		if (isDeepLink && !request.signal?.aborted) {
			logger.debug({ host: target.hostname }, '[CamoufoxSolver] Warming up on site root');
			await page
				.goto(target.origin + '/', {
					timeout: Math.min(remaining(), 30000),
					waitUntil: 'domcontentloaded'
				})
				.catch(() => {});
			await waitForChallengeComplete(page, Math.min(remaining(), 30000));
		}

		// Navigate to the actual target URL (reusing the warmed session).
		let response = await page.goto(request.url, {
			timeout: Math.min(remaining(), 30000),
			waitUntil: 'domcontentloaded'
		});

		if (!response) {
			return {
				success: false,
				body: '',
				url: request.url,
				status: 0,
				headers: {},
				cookies: [],
				userAgent: '',
				error: 'No response received',
				timeMs: Date.now() - startTime
			};
		}

		// Wait for any challenge to complete (auto-solve or Turnstile hand-off).
		logger.debug('[CamoufoxSolver] Waiting for any challenge to complete');
		const mainWaitBudget = opts.waitCapMs ? Math.min(remaining(), opts.waitCapMs) : remaining();
		let solved = await waitForChallengeComplete(page, mainWaitBudget);

		// Fallback: if a non-deep-link somehow still shows a challenge, try a root
		// warm-up + retry once (covers sites that challenge even the root path).
		if (!solved && !isDeepLink && remaining() > 8000 && !request.signal?.aborted) {
			await waitForChallengeComplete(page, Math.min(remaining(), 20000));
			const retryResponse = await page
				.goto(request.url, { timeout: Math.min(remaining(), 30000), waitUntil: 'domcontentloaded' })
				.catch(() => null);
			if (retryResponse) response = retryResponse;
			solved = await waitForChallengeComplete(page, remaining());
		}

		if (!solved) {
			return {
				success: false,
				body: '',
				url: request.url,
				status: 0,
				headers: {},
				cookies: [],
				userAgent: '',
				error: `Cloudflare bypass failed for ${new URL(request.url).hostname}: challenge not solved within timeout`,
				timeMs: Date.now() - startTime
			};
		}

		// Binary mode: solve the challenge as usual, then pull the payload through
		// the browser context's request client. It shares the solved session's
		// cookies and user agent, which Cloudflare accepts where a plain Node
		// fetch with mismatched fingerprints gets challenged (verified live on
		// rutracker.org dl.php, issue #228). Navigation to binary endpoints is
		// avoided entirely — Firefox would not expose their bytes via page.content().
		if (request.binary) {
			const finalCookies = await camoufoxManager.extractCookies(managed.context, [request.url]);
			const requestHeaders: Record<string, string> = {};
			if (request.referer) {
				requestHeaders.Referer = request.referer;
			}

			const apiResponse = await managed.context.request.get(request.url, {
				headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
				maxRedirects: 5,
				timeout: Math.max(1000, timeout - (Date.now() - startTime))
			});
			const data = await apiResponse.body().catch(() => Buffer.alloc(0));

			if (!apiResponse.ok() || data.length === 0) {
				return {
					success: false,
					body: '',
					url: request.url,
					status: apiResponse.status(),
					headers: {},
					cookies: finalCookies,
					userAgent: '',
					error: `Binary fetch failed for ${new URL(request.url).hostname}: HTTP ${apiResponse.status()} (${data.length} bytes)`,
					timeMs: Date.now() - startTime
				};
			}

			logger.debug(
				{
					url: request.url,
					status: apiResponse.status(),
					dataLength: data.length,
					timeMs: Date.now() - startTime
				},
				'[CamoufoxSolver] Binary fetch completed'
			);

			return {
				success: true,
				body: '',
				data,
				url: request.url,
				status: apiResponse.status(),
				headers: {},
				cookies: finalCookies,
				userAgent: '',
				timeMs: Date.now() - startTime
			};
		}

		// Get the page content (skipped when the caller only needs clearance cookies)
		const body = request.returnOnlyCookies ? '' : await page.content();
		const finalUrl = page.url();

		// Guard against a false success: if we still hold the challenge/interstitial
		// page (e.g. clearance never actually issued — common on flagged IPs), do NOT
		// hand the challenge HTML to the caller's parser. Fail honestly instead.
		if (!request.returnOnlyCookies && bodyLooksLikeChallenge(body)) {
			return {
				success: false,
				body: '',
				url: request.url,
				status: 0,
				headers: {},
				cookies: [],
				userAgent: '',
				error: `Cloudflare bypass failed for ${new URL(request.url).hostname}: challenge page returned`,
				timeMs: Date.now() - startTime
			};
		}

		logger.debug(
			{
				url: request.url,
				finalUrl,
				bodyLength: body.length,
				timeMs: Date.now() - startTime
			},
			'[CamoufoxSolver] Browser fetch completed'
		);

		const userAgent = await page
			.evaluate(() => navigator.userAgent)
			.catch(
				() => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'
			);

		const cookies = await camoufoxManager.extractCookies(managed.context, [finalUrl]);
		const headers = response.headers();

		// Return 200 status - the initial response status may have been 403/503
		// but after solving the challenge we have successful content
		return {
			success: true,
			body,
			url: finalUrl,
			status: 200,
			headers,
			cookies,
			userAgent,
			timeMs: Date.now() - startTime
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error({ err: error }, '[CamoufoxSolver] Browser fetch error');
		return {
			success: false,
			body: '',
			url: request.url,
			status: 0,
			headers: {},
			cookies: [],
			userAgent: '',
			error: errorMessage,
			timeMs: Date.now() - startTime
		};
	} finally {
		detachAbort();
		if (managed) {
			await camoufoxManager.closeBrowser(managed);
		}
	}
}
