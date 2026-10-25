/**
 * Captcha detection and handling for indexer requests.
 *
 * This module provides detection for common captcha systems.
 * When a captcha is detected, the indexer will report an error to the user.
 * Future versions may include native solving capabilities.
 *
 * Supported captcha systems:
 * - reCAPTCHA v2/v3
 * - hCaptcha
 * - Cloudflare Turnstile
 * - Simple image captchas (detection only)
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'CaptchaHandler' });

/** Types of captchas that can be detected */
export type CaptchaType =
	'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile' | 'image' | 'unknown';

/** Result of captcha detection */
export interface CaptchaDetectionResult {
	/** Whether a captcha was detected */
	detected: boolean;
	/** Type of captcha detected */
	type?: CaptchaType;
	/** Site key for the captcha (if applicable) */
	siteKey?: string;
	/** Action parameter (for reCAPTCHA v3) */
	action?: string;
	/** Additional metadata about the captcha */
	metadata?: Record<string, string>;
}

/** Configuration for captcha handling */
export interface CaptchaConfig {
	/** Whether to attempt automatic solving (future capability) */
	autoSolve?: boolean;
	/** Timeout for solving attempts in milliseconds */
	solveTimeout?: number;
	/** Whether to pause and wait for manual intervention */
	allowManualSolve?: boolean;
}

/** Result of captcha solving attempt */
export interface CaptchaSolveResult {
	/** Whether the captcha was solved */
	success: boolean;
	/** The solution token (if solved) */
	token?: string;
	/** Error message (if failed) */
	error?: string;
	/** Method used to solve */
	method?: 'native' | 'manual' | 'bypass';
}

/**
 * Captcha detection patterns
 */
const CAPTCHA_PATTERNS = {
	// reCAPTCHA v2
	recaptchaV2: [
		/class=["']g-recaptcha["']/i,
		/data-sitekey=["']([^"']+)["']/i,
		/www\.google\.com\/recaptcha\/api\.js/i,
		/grecaptcha\.render/i
	],
	// reCAPTCHA v3
	recaptchaV3: [
		/grecaptcha\.execute\s*\(\s*["']([^"']+)["']/i,
		/www\.google\.com\/recaptcha\/api\.js\?render=/i
	],
	// hCaptcha
	hcaptcha: [
		/class=["']h-captcha["']/i,
		/data-sitekey=["']([^"']+)["'].*h-captcha/i,
		/js\.hcaptcha\.com\/1\/api\.js/i,
		/hcaptcha\.render/i
	],
	// Cloudflare Turnstile
	turnstile: [
		/class=["']cf-turnstile["']/i,
		/challenges\.cloudflare\.com\/turnstile/i,
		/data-sitekey=["']([^"']+)["'].*cf-turnstile/i
	],
	// Generic image captcha indicators
	imageCaptcha: [
		/captcha/i,
		/<img[^>]*captcha[^>]*>/i,
		/type=["']captcha["']/i,
		/id=["']captcha["']/i
	]
};

/**
 * Detect captcha presence in HTML content.
 */
export function detectCaptcha(html: string, url?: string): CaptchaDetectionResult {
	// Check for reCAPTCHA v3 first (more specific)
	for (const pattern of CAPTCHA_PATTERNS.recaptchaV3) {
		const match = html.match(pattern);
		if (match) {
			const siteKey = extractSiteKey(html, 'recaptcha') ?? match[1];
			logger.debug({ url, siteKey }, 'Detected reCAPTCHA v3');
			return {
				detected: true,
				type: 'recaptcha-v3',
				siteKey,
				action: extractRecaptchaAction(html)
			};
		}
	}

	// Check for reCAPTCHA v2
	for (const pattern of CAPTCHA_PATTERNS.recaptchaV2) {
		if (pattern.test(html)) {
			const siteKey = extractSiteKey(html, 'recaptcha');
			logger.debug({ url, siteKey }, 'Detected reCAPTCHA v2');
			return {
				detected: true,
				type: 'recaptcha-v2',
				siteKey
			};
		}
	}

	// Check for hCaptcha
	for (const pattern of CAPTCHA_PATTERNS.hcaptcha) {
		if (pattern.test(html)) {
			const siteKey = extractSiteKey(html, 'hcaptcha');
			logger.debug({ url, siteKey }, 'Detected hCaptcha');
			return {
				detected: true,
				type: 'hcaptcha',
				siteKey
			};
		}
	}

	// Check for Cloudflare Turnstile
	for (const pattern of CAPTCHA_PATTERNS.turnstile) {
		if (pattern.test(html)) {
			const siteKey = extractSiteKey(html, 'turnstile');
			logger.debug({ url, siteKey }, 'Detected Cloudflare Turnstile');
			return {
				detected: true,
				type: 'turnstile',
				siteKey
			};
		}
	}

	// Check for generic image captcha (less confident)
	for (const pattern of CAPTCHA_PATTERNS.imageCaptcha) {
		if (pattern.test(html)) {
			// Only flag as captcha if it looks like a form with captcha
			if (html.includes('<form') && /captcha/i.test(html)) {
				logger.debug({ url }, 'Detected potential image captcha');
				return {
					detected: true,
					type: 'image'
				};
			}
		}
	}

	return { detected: false };
}

/**
 * Extract site key from HTML for various captcha types.
 */
function extractSiteKey(
	html: string,
	type: 'recaptcha' | 'hcaptcha' | 'turnstile'
): string | undefined {
	const patterns: Record<string, RegExp[]> = {
		recaptcha: [
			/data-sitekey=["']([^"']+)["']/i,
			/grecaptcha\.execute\s*\(\s*["']([^"']+)["']/i,
			/render=([^"'&\s]+)/i
		],
		hcaptcha: [
			/data-sitekey=["']([^"']+)["']/i,
			/hcaptcha\.render\s*\([^,]+,\s*\{\s*sitekey:\s*["']([^"']+)["']/i
		],
		turnstile: [
			/data-sitekey=["']([^"']+)["']/i,
			/turnstile\.render\s*\([^,]+,\s*\{\s*sitekey:\s*["']([^"']+)["']/i
		]
	};

	for (const pattern of patterns[type] ?? []) {
		const match = html.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}

	return undefined;
}

/**
 * Extract reCAPTCHA v3 action from HTML.
 */
function extractRecaptchaAction(html: string): string | undefined {
	const match = html.match(/grecaptcha\.execute\s*\([^,]+,\s*\{\s*action:\s*["']([^"']+)["']/i);
	return match?.[1];
}

/**
 * CaptchaHandler class for managing captcha challenges.
 */
export class CaptchaHandler {
	private config: CaptchaConfig;

	constructor(config: CaptchaConfig = {}) {
		this.config = {
			autoSolve: true,
			solveTimeout: 120000, // 2 minutes
			allowManualSolve: false,
			...config
		};
	}

	/**
	 * Check if HTML content contains a captcha.
	 */
	detect(html: string, url?: string): CaptchaDetectionResult {
		return detectCaptcha(html, url);
	}

	/**
	 * Attempt to solve a detected captcha.
	 * Currently reports detection - native solving is a future capability.
	 */
	async solve(detection: CaptchaDetectionResult): Promise<CaptchaSolveResult> {
		if (!detection.detected) {
			return { success: true, method: 'bypass' };
		}

		// Native captcha solving is planned for future versions
		// For now, we report the detection to the user
		if (this.config.autoSolve) {
			logger.info(
				{
					type: detection.type,
					siteKey: detection.siteKey
				},
				'Captcha detected - native solving not yet implemented'
			);

			return {
				success: false,
				error: `${detection.type} captcha detected. This site may require manual access or an alternate URL.`
			};
		}

		if (this.config.allowManualSolve) {
			// In future, this could trigger a UI notification for manual solving
			return {
				success: false,
				error: 'Manual captcha solving not yet implemented'
			};
		}

		return {
			success: false,
			error: `Captcha detected (${detection.type}) but no solving method available`
		};
	}

	/**
	 * Check if response indicates a captcha challenge and throw if detected.
	 */
	checkAndThrow(html: string, url: string): void {
		const detection = this.detect(html, url);
		if (detection.detected) {
			throw new CaptchaRequiredError(detection, url);
		}
	}
}

/**
 * Error thrown when a captcha is required to proceed.
 */
export class CaptchaRequiredError extends Error {
	readonly detection: CaptchaDetectionResult;
	readonly url: string;

	constructor(detection: CaptchaDetectionResult, url: string) {
		super(`Captcha required: ${detection.type ?? 'unknown'}`);
		this.name = 'CaptchaRequiredError';
		this.detection = detection;
		this.url = url;
	}
}

/**
 * Create a new CaptchaHandler instance.
 */
export function createCaptchaHandler(config?: CaptchaConfig): CaptchaHandler {
	return new CaptchaHandler(config);
}

/**
 * Quick check if HTML contains any captcha.
 */
export function hasCaptcha(html: string): boolean {
	return detectCaptcha(html).detected;
}
