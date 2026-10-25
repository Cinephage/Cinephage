/**
 * Browser crash guard.
 *
 * Camoufox drives a real headless Firefox through playwright-core. Certain
 * challenge pages emit uncaught page errors whose `location` is undefined, which
 * makes playwright-core throw *synchronously inside its own event emitter*:
 *
 *   TypeError: Cannot read properties of undefined (reading 'url')
 *     at FFBrowserContext ... FFPage._onUncaughtError (playwright-core/coreBundle.js)
 *
 * Because that throw happens inside playwright's internals (not in our awaited
 * calls), a normal try/catch cannot intercept it — it surfaces as a Node
 * `uncaughtException` and, with no global handler, terminates the whole server.
 *
 * This guard installs a single, idempotent process handler that swallows ONLY
 * errors originating from the browser stack (Camoufox / Playwright / Firefox),
 * logging them, while preserving Node's default crash-on-real-bug behavior for
 * everything else (log + non-zero exit).
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** Markers that identify the headless-browser stack in an error's stack trace. */
const BROWSER_STACK_MARKERS =
	/playwright-core|coreBundle|camoufox|FFBrowserContext|FFBrowser|FFSession|FFPage|CRBrowser|chromium|_onUncaughtError/i;

/** Messages that are characteristic of transient browser/protocol failures. */
const BROWSER_MESSAGE_MARKERS =
	/Target (?:closed|page, context or browser has been closed)|Browser(?:Context)? has been closed|Execution context was destroyed|Protocol error|Navigation (?:failed|interrupted)|net::ERR|Page crashed|Session closed/i;

/**
 * Decide whether an uncaught error/rejection originated from the headless
 * browser stack (and is therefore safe to swallow rather than crash on).
 */
export function isBrowserOriginError(err: unknown): boolean {
	if (err instanceof Error) {
		const stack = err.stack ?? '';
		const message = err.message ?? '';
		return BROWSER_STACK_MARKERS.test(stack) || BROWSER_MESSAGE_MARKERS.test(message);
	}
	// Non-Error throws (rare): inspect the string form.
	const asString = typeof err === 'string' ? err : String(err ?? '');
	return BROWSER_STACK_MARKERS.test(asString) || BROWSER_MESSAGE_MARKERS.test(asString);
}

// A module-scoped `let` guard resets on every Vite dev SSR HMR reload (the
// module is re-evaluated from scratch), but process.on listeners stack onto
// the real, HMR-independent process object regardless, so the guard alone
// doesn't stop duplicate listeners from piling up across a long dev session.
// globalThis survives reloads; it doesn't survive a real process restart,
// which is fine since a fresh process has never installed these either.
const installGuard = globalThis as typeof globalThis & {
	__cinephageBrowserCrashGuardInstalled?: boolean;
};

/**
 * Install the crash guard exactly once. Safe to call repeatedly.
 *
 * Skipped under Vitest so unit tests keep their own uncaught-error semantics.
 */
export function installBrowserCrashGuard(): void {
	if (installGuard.__cinephageBrowserCrashGuardInstalled) return;
	if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
	installGuard.__cinephageBrowserCrashGuardInstalled = true;

	process.on('uncaughtException', (err, origin) => {
		if (isBrowserOriginError(err)) {
			logger.warn(
				{ err, origin },
				'[BrowserCrashGuard] Swallowed browser-origin uncaught exception (process kept alive)'
			);
			return;
		}
		// Not ours — preserve Node's default crash semantics so real bugs surface.
		logger.error({ err, origin }, '[BrowserCrashGuard] Fatal uncaught exception; exiting');
		process.exitCode = 1;
		setTimeout(() => process.exit(1), 50).unref();
	});

	process.on('unhandledRejection', (reason) => {
		if (isBrowserOriginError(reason)) {
			logger.warn(
				{ err: reason },
				'[BrowserCrashGuard] Swallowed browser-origin unhandled rejection (process kept alive)'
			);
			return;
		}
		// Match Node's default (crash) for unrelated rejections so real bugs surface.
		logger.error({ err: reason }, '[BrowserCrashGuard] Fatal unhandled rejection; exiting');
		process.exitCode = 1;
		setTimeout(() => process.exit(1), 50).unref();
	});

	logger.info('[BrowserCrashGuard] Installed');
}

/** Test-only: reset the install latch. */
export function __resetBrowserCrashGuardForTests(): void {
	installGuard.__cinephageBrowserCrashGuardInstalled = false;
}
