/**
 * API Test Helper
 *
 * Provides utilities for testing SvelteKit API endpoints directly.
 * Creates mock Request objects and parses Response objects for assertions.
 */
import { type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { isAppError } from '#lib/errors/index.js';
import { logger } from '#lib/logging/index.js';

type AnyRequestHandler = RequestHandler<any, any>;
type TestAuthMode = 'admin' | 'user' | false;

interface RequestOptions {
	url?: string;
	headers?: Record<string, string>;
	auth?: TestAuthMode;
	/**
	 * When set alongside auth, locals.session carries this token for the same
	 * synthetic user — for endpoints that reason about the current session.
	 */
	sessionToken?: string;
}

interface HandlerOptions extends RequestOptions {
	params?: Record<string, string>;
}

function createTestUser(role: 'admin' | 'user'): App.Locals['user'] {
	const now = new Date();

	return {
		id: `test-${role}-user`,
		name: `${role} tester`,
		email: `${role}@example.com`,
		emailVerified: false,
		image: null,
		username: `${role}_tester`,
		displayUsername: `${role}_tester`,
		role,
		language: 'en',
		banned: false,
		banReason: null,
		banExpires: null,
		createdAt: now,
		updatedAt: now
	};
}

function createTestSession(user: NonNullable<App.Locals['user']>, token: string) {
	const now = new Date();

	return {
		id: `test-session-${user.role}`,
		userId: user.id,
		token,
		expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
		ipAddress: null,
		userAgent: null,
		impersonatedBy: null,
		createdAt: now,
		updatedAt: now
	};
}

function createTestLocals(options: RequestOptions): App.Locals {
	const user = options.auth ? createTestUser(options.auth) : null;

	return {
		correlationId: 'test-correlation-id',
		requestId: 'test-correlation-id',
		supportId: 'test-support-id',
		logger,
		user,
		session: user && options.sessionToken ? createTestSession(user, options.sessionToken) : null,
		apiKey: null,
		apiKeyPermissions: null
	};
}

/**
 * Create a mock Request object for testing
 */
export function createRequest(method: string, body?: unknown, options?: RequestOptions): Request {
	const url = options?.url ?? 'http://localhost/api/test';
	const headers = new Headers({
		'Content-Type': 'application/json',
		...options?.headers
	});

	const requestInit: RequestInit = {
		method,
		headers
	};

	if (body !== undefined && method !== 'GET') {
		requestInit.body = JSON.stringify(body);
	}

	return new Request(url, requestInit);
}

/**
 * Create a minimal RequestEvent for testing handlers
 */
export function createRequestEvent(
	request: Request,
	params: Record<string, string> = {},
	options?: RequestOptions
): Partial<RequestEvent> {
	return {
		request,
		params,
		url: new URL(request.url),
		locals: createTestLocals(options ?? {}),
		platform: undefined,
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		} as unknown as RequestEvent['cookies'],
		fetch: globalThis.fetch,
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		isDataRequest: false,
		isSubRequest: false
	};
}

/**
 * Call an API handler and get the raw Response (for binary bodies/headers).
 */
export async function callHandlerRaw(
	handler: AnyRequestHandler,
	method: string,
	body?: unknown,
	options?: HandlerOptions
): Promise<{ status: number; response: Response }> {
	const request = createRequest(method, body, options);
	const event = createRequestEvent(request, options?.params, options);

	let response: Response;
	try {
		response = await handler(event as RequestEvent);
	} catch (error) {
		if (isAppError(error)) {
			response = Response.json({ success: false, ...error.toJSON() }, { status: error.statusCode });
		} else {
			throw error;
		}
	}

	return { status: response.status, response };
}

/**
 * Helper to call an API handler and get parsed response
 */
export async function callHandler<T = unknown>(
	handler: AnyRequestHandler,
	method: string,
	body?: unknown,
	options?: HandlerOptions
): Promise<{ status: number; data: T }> {
	const { status, response } = await callHandlerRaw(handler, method, body, options);
	const data = (await response.json()) as T;

	return { status, data };
}

/**
 * Shorthand helpers for common HTTP methods
 */
export const api = {
	async get<T = unknown>(
		handler: AnyRequestHandler,
		options?: HandlerOptions
	): Promise<{ status: number; data: T }> {
		return callHandler<T>(handler, 'GET', undefined, options);
	},

	async post<T = unknown>(
		handler: AnyRequestHandler,
		body: unknown,
		options?: HandlerOptions
	): Promise<{ status: number; data: T }> {
		return callHandler<T>(handler, 'POST', body, {
			auth: 'admin',
			...options
		});
	},

	async put<T = unknown>(
		handler: AnyRequestHandler,
		body: unknown,
		options?: HandlerOptions
	): Promise<{ status: number; data: T }> {
		return callHandler<T>(handler, 'PUT', body, {
			auth: 'admin',
			...options
		});
	},

	async delete<T = unknown>(
		handler: AnyRequestHandler,
		body: unknown,
		options?: HandlerOptions
	): Promise<{ status: number; data: T }> {
		return callHandler<T>(handler, 'DELETE', body, {
			auth: 'admin',
			...options
		});
	}
};

/**
 * Type helpers for common API response shapes
 */
export interface ProfilesListResponse {
	profiles: Array<{
		id: string;
		name: string;
		description?: string;
		isBuiltIn: boolean;
		isDefault: boolean;
		formatScores?: Record<string, number>;
		movieMinSizeGb?: number | null;
		movieMaxSizeGb?: number | null;
		episodeMinSizeMb?: number | null;
		episodeMaxSizeMb?: number | null;
	}>;
	count: number;
	defaultProfileId: string;
}

export interface ProfileResponse {
	id: string;
	name: string;
	description?: string;
	formatScores?: Record<string, number>;
	isDefault?: boolean;
	isBuiltIn?: boolean;
	upgradesAllowed?: boolean;
	minScore?: number;
	upgradeUntilScore?: number;
	minScoreIncrement?: number;
	movieMinSizeGb?: number | null;
	movieMaxSizeGb?: number | null;
	episodeMinSizeMb?: number | null;
	episodeMaxSizeMb?: number | null;
}

export interface ErrorResponse {
	error: string;
	details?: unknown;
}

export interface DeleteResponse {
	success: boolean;
	deleted: { id: string; [key: string]: unknown };
}

export interface FormatResponse {
	id: string;
	name: string;
	description?: string;
	category?: string;
	tags?: string[];
	conditions?: unknown[];
	isBuiltIn?: boolean;
	enabled?: boolean;
}

export interface FormatsListResponse {
	formats: FormatResponse[];
	count?: number;
	builtInCount: number;
	customCount: number;
}
