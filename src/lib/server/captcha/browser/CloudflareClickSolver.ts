/**
 * Cloudflare click solver.
 *
 * Cloudflare's Turnstile/managed-challenge checkbox lives inside a CLOSED shadow
 * DOM nested in a cross-origin iframe (`challenges.cloudflare.com`). Our Camoufox
 * addon (browser/addon) forces every shadow root open in the page's main world,
 * which lets a plain Playwright locator reach the checkbox. The click itself must
 * be a real, trusted input event dispatched at the checkbox's viewport
 * coordinates — Playwright's `locator.click()` (even `force`) times out on the
 * cross-origin iframe, but `page.mouse.click(x, y)` at the element's bounding-box
 * centre works and produces a valid clearance token.
 *
 * Technique adapted from techinz/playwright-captcha (Apache-2.0), reimplemented
 * natively so captcha solving stays first-party (no runtime dependency).
 */

import type { Page, Frame } from 'playwright-core';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** URL marker for the Cloudflare challenge iframe. */
const CF_CHALLENGE_FRAME_RE = /challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform/;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Find the live Cloudflare challenge iframe among the page's frames, if present.
 * Frames are listed regardless of shadow-DOM nesting, so this finds the widget
 * even when the host page embeds it inside a shadow root.
 */
export function findChallengeFrame(page: Page): Frame | null {
	for (const frame of page.frames()) {
		if (CF_CHALLENGE_FRAME_RE.test(frame.url()) && !frame.isDetached()) {
			return frame;
		}
	}
	return null;
}

/**
 * Dispatch a trusted, slightly-humanised mouse click at viewport coordinates.
 */
async function humanClickAt(page: Page, x: number, y: number): Promise<void> {
	await page.mouse.move(x - 42, y - 13).catch(() => {});
	await delay(90);
	await page.mouse.move(x, y, { steps: 6 }).catch(() => {});
	await delay(60);
	await page.mouse.click(x, y).catch(() => {});
}

/**
 * Attempt to click the Cloudflare challenge checkbox once.
 *
 * Returns true only if a checkbox was found visible and a click was dispatched.
 * Safe to call repeatedly; callers poll for the actual success signal separately.
 */
export async function attemptChallengeCheckboxClick(page: Page): Promise<boolean> {
	const frame = findChallengeFrame(page);
	if (!frame) return false;

	try {
		// The addon opens the shadow root, so a normal locator pierces to the checkbox.
		const checkbox = frame.locator('input[type="checkbox"]').first();
		const visible = await checkbox.isVisible().catch(() => false);
		if (!visible) return false;

		const box = await checkbox.boundingBox().catch(() => null);
		if (!box) return false;

		await humanClickAt(page, box.x + box.width / 2, box.y + box.height / 2);
		logger.debug('[ClickSolver] Dispatched click on Cloudflare challenge checkbox');
		return true;
	} catch (error) {
		logger.debug(
			{ error: error instanceof Error ? error.message : String(error) },
			'[ClickSolver] Checkbox click attempt failed'
		);
		return false;
	}
}

/**
 * Whether the page currently holds a Cloudflare Turnstile clearance token
 * (the widget writes it into the hidden `cf-turnstile-response` input on success).
 */
export async function hasTurnstileToken(page: Page): Promise<boolean> {
	const tokenLength = await page
		.evaluate(() => {
			const el = document.querySelector('input[name="cf-turnstile-response"]');
			return el instanceof HTMLInputElement && el.value ? el.value.length : 0;
		})
		.catch(() => 0);
	return tokenLength > 0;
}

/**
 * Full standalone Turnstile solve: click the checkbox and wait for a token or the
 * widget's `#success` indicator. Used for pages gated purely by a Turnstile widget
 * (as opposed to a full-page interstitial, whose completion is a title change).
 */
export async function solveTurnstileByClick(
	page: Page,
	opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<boolean> {
	const deadline = Date.now() + opts.timeoutMs;
	let clicked = false;

	while (Date.now() < deadline) {
		if (opts.signal?.aborted) return false;

		if (await hasTurnstileToken(page)) return true;

		const frame = findChallengeFrame(page);
		if (frame) {
			const successVisible = await frame
				.locator('#success')
				.isVisible()
				.catch(() => false);
			if (successVisible) return true;

			if (!clicked) {
				clicked = await attemptChallengeCheckboxClick(page);
			}
		}

		await delay(600);
	}

	return hasTurnstileToken(page);
}
