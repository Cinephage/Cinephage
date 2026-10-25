import { isHttpError } from '@sveltejs/kit';
import type { HandleServerError } from '@sveltejs/kit/hooks';
import { isAppError } from '#lib/errors/index.js';
import { logger } from '#lib/logging/index.js';
import { createSupportId } from '#lib/server/auth/session-helpers.js';

const handleError: HandleServerError = ({ error, event }) => {
	const correlationId = event.locals.requestId ?? event.locals.correlationId ?? 'unknown';
	const supportId = event.locals.supportId ?? createSupportId();
	const requestLogger = event.locals.logger ?? logger;

	// SvelteKit 3 routes expected error(...) throws through handleError too.
	// They are routine request outcomes, not failures — log at info and keep
	// the authored message; only >=500 stays on the uncaught-exception path.
	if (isHttpError(error) && error.status < 500 && error instanceof Error) {
		requestLogger.info(
			{
				requestId: correlationId,
				correlationId,
				status: error.status,
				logDomain: 'http',
				method: event.request.method,
				path: event.url.pathname
			},
			'Expected HTTP error'
		);
		return { message: error.message, code: 'HTTP_ERROR', supportId };
	}

	requestLogger.error(
		{
			err: error,
			requestId: correlationId,
			correlationId,
			supportId,
			logDomain: 'http',
			method: event.request.method,
			path: event.url.pathname
		},
		'Uncaught exception'
	);

	if (isAppError(error)) {
		return {
			message: error.message,
			code: error.code,
			supportId
		};
	}

	// Messages from error()/AppError are developer-authored and safe to surface
	// (404 guidance, validation hints). Anything else is an internal failure
	// whose raw message can carry paths, SQL, or upstream URLs — keep it in the
	// logs and return a generic message.
	const message =
		isHttpError(error) && error.status < 500 && error instanceof Error
			? error.message
			: 'An unexpected error occurred';

	return {
		message,
		code: 'INTERNAL_ERROR',
		supportId
	};
};

export { handleError };
