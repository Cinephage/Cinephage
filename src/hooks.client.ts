import { isHttpError } from '@sveltejs/kit';
import type { HandleClientError } from '@sveltejs/kit/hooks';

import { logger } from '#lib/logging/index.js';

interface ClientErrorReportPayload {
	supportId: string;
	message: string;
	status?: number;
	path: string;
	routeId?: string | null;
	userAgent?: string;
	error?: {
		name?: string;
		message?: string;
		stack?: string;
	};
}

function createClientSupportId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID().split('-')[0] ?? crypto.randomUUID();
	}

	return Math.random().toString(36).slice(2, 10);
}

function serializeClientError(error: unknown): ClientErrorReportPayload['error'] | undefined {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack
		};
	}

	// Non-Error throws (DOMException, plain strings, NS_ERROR_FAILURE...) must
	// still serialize — dropping them turned every such crash into `err: {}`.
	if (typeof error === 'string') {
		return { name: 'string', message: error };
	}
	if (error && typeof error === 'object') {
		const anyError = error as { name?: unknown; message?: unknown };
		return {
			name: typeof anyError.name === 'string' ? anyError.name : 'unknown',
			message:
				typeof anyError.message === 'string' && anyError.message ? anyError.message : String(error)
		};
	}
	return { name: 'unknown', message: String(error) };
}

function reportClientError(payload: ClientErrorReportPayload): void {
	if (typeof fetch !== 'function') {
		return;
	}

	void fetch('/api/settings/logs/client-report', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		credentials: 'same-origin',
		body: JSON.stringify(payload)
	}).catch(() => {
		// Best-effort reporting only; never disrupt the client error path.
	});
}

export const handleError: HandleClientError = ({ error, event }) => {
	// SvelteKit 3 routes expected error(...) throws through handleError too.
	// Surface the authored message and skip crash reporting for them.
	if (isHttpError(error) && error.status < 500) {
		return { message: error.body.message, code: 'HTTP_ERROR' };
	}

	const supportId = createClientSupportId();
	const message = 'Unhandled client error';
	const serializedError = serializeClientError(error);

	logger.error(
		{
			err: error,
			logDomain: 'client',
			component: 'hooks.client',
			supportId,
			path: event.url.pathname,
			routeId: event.route.id ?? null
		},
		message
	);

	reportClientError({
		supportId,
		message,
		path: event.url.pathname,
		routeId: event.route.id ?? null,
		userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
		error: serializedError
	});

	return {
		message: 'An unexpected error occurred',
		code: 'CLIENT_ERROR',
		supportId
	};
};
