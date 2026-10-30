/**
 * Gateway request signing — HMAC-SHA256 over `v1:{METHOD}:{PATH}:{TIMESTAMP}`.
 *
 * The api.cinephage.net gateway issues a per-release `signing_secret` at
 * publish time. Builds that published themselves with `requires_signature`
 * carry it via the CINEPHAGE_SIGNING_SECRET env var (baked into official
 * Docker images; bare-metal installs set it themselves). While the gateway
 * runs with enforcement off, a missing secret keeps the legacy header-only
 * access path — signing is purely additive.
 *
 * The signature covers the URL pathname only (no query string), so cached
 * and stream URLs with volatile query params need no re-signing. Replay
 * beyond the gateway's ±300 s window is blocked by the timestamp itself;
 * a learned clock offset (from gateway 401 responses) keeps drifted hosts
 * inside the window.
 */

import { createHmac } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'CinephageGatewaySigning', logDomain: 'system' });

export const SIGNING_SECRET_ENV_VAR = 'CINEPHAGE_SIGNING_SECRET';

/** Error `details.code` values the gateway returns for signature problems. */
const SIGNATURE_REJECTION_CODES = new Set(['invalid_signature', 'signature_required']);

/**
 * Read the gateway signing secret from the environment. Live read (matches
 * the auth-secret convention) so rotation after module init is picked up;
 * empty/whitespace values count as unset (empty Docker ARG build).
 */
export function readGatewaySigningSecret(): string | undefined {
	const raw = process.env[SIGNING_SECRET_ENV_VAR]?.trim();
	return raw ? raw : undefined;
}

/**
 * Build the signature headers for one gateway request. Pure; exported for
 * tests and for callers that already hold the secret.
 */
export function buildSignatureHeaders(
	secret: string,
	method: string,
	path: string,
	nowSeconds = Math.floor(Date.now() / 1000)
): Record<string, string> {
	const payload = `v1:${method.toUpperCase()}:${path}:${nowSeconds}`;
	const signature = createHmac('sha256', secret).update(payload).digest('hex');
	return {
		'X-Cinephage-Timestamp': String(nowSeconds),
		'X-Cinephage-Signature': signature
	};
}

/**
 * Learned offset (ms) between the local clock and the gateway clock. Only
 * populated from gateway signature rejections — the one place where a clock
 * discrepancy is diagnosable from a response.
 */
let gatewayClockOffsetMs = 0;
let activationLogged = false;

/** Learn the gateway clock offset from a response `Date` header. */
export function noteGatewayResponseDate(dateHeader: string | null | undefined): void {
	if (!dateHeader) return;
	const gatewayMs = Date.parse(dateHeader);
	if (Number.isNaN(gatewayMs)) return;
	gatewayClockOffsetMs = gatewayMs - Date.now();
}

/** Extract the URL pathname exactly as sent (query excluded per spec). */
function requestPath(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		// Relative path passed directly; sign it as-is.
		return url;
	}
}

/**
 * Signature headers for a gateway request, or an empty object when no
 * secret is configured (legacy unsigned mode). Callers merge the result
 * alongside the X-Cinephage-Version / X-Cinephage-Commit identity headers.
 */
export function getSignatureHeaders(request: {
	method: string;
	url: string;
}): Record<string, string> {
	const secret = readGatewaySigningSecret();
	if (!secret) {
		return {};
	}

	if (!activationLogged) {
		activationLogged = true;
		if (!process.env.VITE_SSR_BUILD && !process.env.VITEST) {
			logger.info('Gateway request signing active (CINEPHAGE_SIGNING_SECRET is set)');
		}
	}

	return buildSignatureHeaders(
		secret,
		request.method,
		requestPath(request.url),
		Math.floor((Date.now() + gatewayClockOffsetMs) / 1000)
	);
}

/**
 * Check whether a 401 response is a signature rejection (as opposed to an
 * identity/version rejection). Peeks the body via clone, so the response
 * stays readable for the caller.
 */
export async function isGatewaySignatureRejection(response: Response): Promise<boolean> {
	try {
		const body = (await response.clone().json()) as {
			error?: { details?: { code?: string } };
		};
		const code = body.error?.details?.code;
		return typeof code === 'string' && SIGNATURE_REJECTION_CODES.has(code);
	} catch {
		return false;
	}
}

/**
 * Perform a raw gateway fetch with signing-retry semantics: on a 401 whose
 * body indicates a signature problem, learn the gateway clock offset from
 * the response Date header and retry exactly once with freshly signed
 * headers. Non-signature 401s (stale identity) and all other statuses are
 * returned untouched so callers keep their existing handling.
 *
 * `getHeaders` is re-invoked per attempt so each attempt gets a fresh
 * timestamp; callers merge their identity headers with getSignatureHeaders().
 */
export async function signedGatewayFetch(
	url: string,
	options: { accept: string; timeoutMs: number },
	getHeaders: () => Promise<Record<string, string>>
): Promise<Response> {
	const send = async (): Promise<Response> =>
		fetch(url, {
			headers: { Accept: options.accept, ...(await getHeaders()) },
			signal: AbortSignal.timeout(options.timeoutMs)
		});

	let response = await send();
	if (response.status === 401 && (await isGatewaySignatureRejection(response))) {
		noteGatewayResponseDate(response.headers.get('date'));
		response = await send();
	}
	return response;
}

/** Test hook: clear learned clock state. */
export function resetGatewaySigningState(): void {
	gatewayClockOffsetMs = 0;
	activationLogged = false;
}
