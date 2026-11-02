/**
 * Camoufox browser provisioning.
 *
 * The launcher pins one browser build per release and installs it on demand,
 * but that first download (browser + GeoIP, ~1.4GB on Linux) would block the
 * first challenge solve and usually time it out. Do the check at startup
 * instead: when the paired build is not the active install, fetch it in the
 * background so self-hosted deployments track the build the installed launcher
 * expects.
 *
 * Disable with CAMOUFOX_AUTO_FETCH=false (air-gapped installs).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { findInstalledVersion } from 'camoufox';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** Browser downloads are ~1.4GB on Linux; allow a slow link to finish. */
const FETCH_TIMEOUT_MS = 30 * 60_000;

/**
 * Decide whether the paired browser build needs to be fetched.
 *
 * `pairedInstalled` says whether the build the launcher pins is present, and
 * `pinTag` is that pin ("v156.0.1-beta.34") or null in a dev checkout that
 * pins nothing — there the launcher's own on-demand install is good enough, so
 * do not churn. Checking the pinned build rather than the active build means a
 * deliberate `camoufox set` choice is left alone.
 */
export function shouldProvisionBrowser(pairedInstalled: boolean, pinTag: string | null): boolean {
	if (!pinTag) return false;
	return !pairedInstalled;
}

function resolveCliPath(): string | null {
	try {
		return createRequire(import.meta.url).resolve('camoufox/dist/__main__.js');
	} catch (error) {
		logger.debug({ err: error }, '[CamoufoxProvision] Launcher CLI not resolvable');
		return null;
	}
}

function readPinTag(cliPath: string): string | null {
	try {
		const raw = readFileSync(join(dirname(cliPath), 'data-files', 'browser-pin.json'), 'utf8');
		const parsed = JSON.parse(raw) as { tag?: unknown };
		return typeof parsed.tag === 'string' && parsed.tag.length > 0 ? parsed.tag : null;
	} catch {
		return null;
	}
}

function runCli(
	cliPath: string,
	args: string[],
	timeoutMs: number
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		const capture = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > 4000) {
				output = output.slice(-4000);
			}
		};
		child.stdout?.on('data', capture);
		child.stderr?.on('data', capture);

		const timer = setTimeout(() => {
			logger.warn('[CamoufoxProvision] Browser fetch timed out; aborting it');
			child.kill('SIGKILL');
		}, timeoutMs);

		child.once('error', () => {
			clearTimeout(timer);
			resolve({ code: null, output });
		});
		child.once('close', (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

/**
 * Check the paired browser and fetch it when needed. Intended to run once at
 * startup: never throws, and the download runs in a child process so the
 * caller is not blocked.
 */
export async function ensureCamoufoxBrowserInBackground(): Promise<void> {
	try {
		if (process.env.CAMOUFOX_AUTO_FETCH === 'false') {
			logger.info('[CamoufoxProvision] Auto-fetch disabled (CAMOUFOX_AUTO_FETCH=false)');
			return;
		}

		const cliPath = resolveCliPath();
		if (!cliPath) return;
		const pinTag = readPinTag(cliPath);

		let pairedInstalled = false;
		if (pinTag) {
			try {
				pairedInstalled = findInstalledVersion(pinTag.replace(/^v/, '')) !== null;
			} catch {
				pairedInstalled = false;
			}
		}

		if (!shouldProvisionBrowser(pairedInstalled, pinTag)) {
			if (pinTag) {
				logger.info(
					{ paired: pinTag },
					'[CamoufoxProvision] Camoufox browser paired with this launcher is installed'
				);
			} else {
				logger.debug('[CamoufoxProvision] This launcher pins no browser build; skipping');
			}
			return;
		}

		logger.info(
			{ paired: pinTag },
			'[CamoufoxProvision] Fetching the Camoufox build paired with this launcher (background; captcha solving becomes available when it finishes)'
		);

		const result = await runCli(cliPath, ['fetch'], FETCH_TIMEOUT_MS);
		if (result.code === 0) {
			logger.info('[CamoufoxProvision] Browser provisioning complete');
		} else {
			logger.warn(
				{ code: result.code, output: result.output.trim().slice(-500) },
				'[CamoufoxProvision] Browser provisioning failed; captcha solving will retry when a solve needs it'
			);
		}
	} catch (error) {
		logger.warn({ err: error }, '[CamoufoxProvision] Unexpected provisioning error');
	}
}
