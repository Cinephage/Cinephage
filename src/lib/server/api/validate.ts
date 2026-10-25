/**
 * API validation helpers.
 * Reduces boilerplate for Zod validation in API routes.
 *
 * Throw-based pattern integrates with hooks.server.ts error handling.
 */

import type { z } from 'zod';
import { NotFoundError, ValidationError } from '#lib/errors/index.js';

/**
 * Assert that a value exists, throwing NotFoundError if null/undefined.
 *
 * @example
 * const movie = assertFound(await getMovie(id), 'Movie', id);
 * // movie is now guaranteed to be non-null
 */
export function assertFound<T>(
	value: T | null | undefined,
	resource: string,
	id?: string | number
): T {
	if (value === null || value === undefined) {
		throw new NotFoundError(resource, id);
	}
	return value;
}

/**
 * Parse and validate request body, throwing ValidationError if invalid.
 *
 * @example
 * const data = await parseBody(request, movieSchema);
 * // data is typed and validated
 */
export async function parseBody<T>(request: Request, schema: z.ZodSchema<T>): Promise<T> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new ValidationError('Invalid JSON body');
	}

	const result = schema.safeParse(body);
	if (!result.success) {
		throw new ValidationError('Validation failed', {
			details: result.error.flatten()
		});
	}

	return result.data;
}

/**
 * Parse and validate an optional request body.
 * Falls back to an empty object if the body is missing or invalid JSON,
 * then validates against the schema.
 *
 * @example
 * const data = await parseOptionalBody(request, scanSchema);
 */
export async function parseOptionalBody<T>(request: Request, schema: z.ZodSchema<T>): Promise<T> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	const result = schema.safeParse(body);
	if (!result.success) {
		throw new ValidationError('Validation failed', {
			details: result.error.flatten()
		});
	}

	return result.data;
}

/**
 * Parse and validate URL search params, throwing ValidationError if invalid.
 *
 * @example
 * const params = parseParams(url.searchParams, querySchema);
 */
export function parseParams<T>(searchParams: URLSearchParams, schema: z.ZodSchema<T>): T {
	const params = Object.fromEntries(searchParams.entries());
	const result = schema.safeParse(params);

	if (!result.success) {
		throw new ValidationError('Invalid query parameters', {
			details: result.error.flatten()
		});
	}

	return result.data;
}

/**
 * Assert a condition, throwing ValidationError if false.
 *
 * @example
 * assertValid(data.title?.length > 0, 'Title is required');
 */
export function assertValid(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new ValidationError(message);
	}
}
