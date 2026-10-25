import type { AsyncLocalStorage as NodeAsyncLocalStorage } from 'node:async_hooks';

import pino, { stdSerializers, type Logger as PinoLogger, type LoggerOptions } from 'pino';

import type { CapturedLogEntry } from './log-capture';
import { PLACEHOLDER_PACKAGE_VERSION } from '#lib/version.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogDomain =
	| 'system'
	| 'http'
	| 'client'
	| 'auth'
	| 'main'
	| 'streams'
	| 'imports'
	| 'monitoring'
	| 'scans'
	| 'indexers'
	| 'subtitles'
	| 'livetv'
	| 'downloads';

export type LogCategory = LogDomain;

export interface LogContext {
	requestId?: string;
	correlationId?: string;
	supportId?: string;
	userId?: string;
	workerId?: string;
	workerType?: string;
	logDomain?: LogDomain;
	domain?: string;
	component?: string;
	module?: string;
	service?: string;
	logCategory?: LogCategory;
	[key: string]: unknown;
}

export type LogPayload = Record<string, unknown>;

export interface AppLogger {
	debug(message: string, context?: LogContext): void;
	debug(context: LogPayload, message?: string): void;
	info(message: string, context?: LogContext): void;
	info(context: LogPayload, message?: string): void;
	warn(message: string, context?: LogContext): void;
	warn(context: LogPayload, message?: string): void;
	error(message: string, error?: unknown, context?: LogContext): void;
	error(context: LogPayload, message?: string): void;
	child(bindings: LogContext): AppLogger;
}

type LogStore = {
	logger: PinoLogger;
	requestId?: string;
	supportId?: string;
};

type PreparedLogEvent = {
	payload?: Record<string, unknown>;
	message?: string;
};

const REDACTED = '[REDACTED]';

const SENSITIVE_QUERY_KEYS = [
	'apikey',
	'api_key',
	'api-key',
	'apiKey',
	'password',
	'passwd',
	'pwd',
	'passkey',
	'secret',
	'token',
	'access_token',
	'auth',
	'authorization',
	'cookie',
	'session',
	'credential',
	'key'
];

const SENSITIVE_OBJECT_KEYS = [
	'apikey',
	'api_key',
	'api-key',
	'apiKey',
	'password',
	'passwd',
	'pwd',
	'passkey',
	'secret',
	'token',
	'access_token',
	'auth',
	'authorization',
	'cookie',
	'session',
	'credential'
];

function getRuntimeEnv(key: string): string | undefined {
	const viteEnv = (import.meta.env as Record<string, unknown> | undefined)?.[key];
	if (typeof viteEnv === 'string') {
		return viteEnv;
	}

	const prefixedViteEnv = (import.meta.env as Record<string, unknown> | undefined)?.[`VITE_${key}`];
	if (typeof prefixedViteEnv === 'string') {
		return prefixedViteEnv;
	}

	if (typeof process !== 'undefined') {
		return process.env?.[key];
	}

	return undefined;
}

function isDev(): boolean {
	try {
		return import.meta.env?.DEV ?? getRuntimeEnv('NODE_ENV') === 'development';
	} catch {
		return false;
	}
}

function shouldIncludeErrorStack(): boolean {
	const configured = getRuntimeEnv('LOG_INCLUDE_STACK');
	if (configured === 'true') return true;
	if (configured === 'false') return false;
	return isDev();
}

function readVersion(value: string | undefined): string | null {
	const normalized = value?.trim();
	if (!normalized) return null;
	if (normalized === '0.0.0') return null;
	if (normalized === PLACEHOLDER_PACKAGE_VERSION) return null;
	return normalized;
}

function resolveLogVersion(): string {
	return (
		readVersion(getRuntimeEnv('APP_VERSION')) ??
		readVersion(getRuntimeEnv('npm_package_version')) ??
		'dev-local'
	);
}

function isRedactionBypassed(): boolean {
	// Escape hatch for local debugging only: a production deployment must not
	// be able to write every token/password in cleartext to stdout and the
	// persisted log history with a single env var.
	if (getRuntimeEnv('NODE_ENV') === 'production') return false;
	return getRuntimeEnv('LOG_SENSITIVE') === 'true';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveObjectKey(key: string): boolean {
	if (isRedactionBypassed()) return false;
	const lower = key.toLowerCase();
	return SENSITIVE_OBJECT_KEYS.some((sensitiveKey) => {
		const sensitiveLower = sensitiveKey.toLowerCase();
		return (
			lower === sensitiveLower ||
			lower.endsWith(`_${sensitiveLower}`) ||
			lower.endsWith(`-${sensitiveLower}`)
		);
	});
}

function redactString(input: string): string {
	if (!input || isRedactionBypassed()) return input;

	const queryKeyPattern = SENSITIVE_QUERY_KEYS.map((key) =>
		key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
	).join('|');

	let redacted = input.replace(/[\r\n]+/g, ' ');

	redacted = redacted.replace(
		/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
		(_match, protocol: string) => `${protocol}${REDACTED}:${REDACTED}@`
	);

	redacted = redacted.replace(
		new RegExp(`([?&](?:${queryKeyPattern})=)[^&\\s;]+`, 'gi'),
		(_match, prefix: string) => `${prefix}${REDACTED}`
	);

	redacted = redacted.replace(
		new RegExp(`\\b(${queryKeyPattern})\\b\\s*[:=]\\s*([^\\s,;]+)`, 'gi'),
		(_match, key: string) => `${key}=${REDACTED}`
	);

	redacted = redacted.replace(
		/\b(authorization|proxy-authorization)\b\s*[:=]\s*(bearer\s+)?([^\s,;]+)/gi,
		(_match, header: string, bearerPrefix?: string) =>
			`${header}: ${(bearerPrefix ?? '').trim()}${bearerPrefix ? ' ' : ''}${REDACTED}`.trim()
	);

	return redacted;
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) return value;

	if (typeof value === 'string') {
		return redactString(value);
	}

	if (typeof value !== 'object') {
		return value;
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (value instanceof URL) {
		return redactString(value.toString());
	}

	if (value instanceof Error) {
		// pino's stdSerializers.err() returns an object with a non-POJO prototype
		// and a Symbol key holding the raw Error. Re-enter sanitizeLogValue so
		// the generic object path (Object.entries loop) converts it to a clean POJO.
		const serialized = stdSerializers.err(toError(value));
		return sanitizeLogValue(serialized, seen);
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeLogValue(item, seen));
	}

	if (seen.has(value as object)) {
		return '[Circular]';
	}

	seen.add(value as object);

	const objectValue = value as Record<string, unknown>;
	const sanitized: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(objectValue)) {
		if (isSensitiveObjectKey(key)) {
			sanitized[key] = REDACTED;
			continue;
		}
		sanitized[key] = sanitizeLogValue(nestedValue, seen);
	}

	return sanitized;
}

function sanitizeContext(context: LogContext): Record<string, unknown> {
	const normalized: LogContext = { ...context };

	if (!normalized.requestId && normalized.correlationId) {
		normalized.requestId = normalized.correlationId;
	}

	if (!normalized.logDomain && normalized.logCategory) {
		normalized.logDomain = normalized.logCategory;
	}

	if (!normalized.component) {
		normalized.component =
			typeof normalized.module === 'string'
				? normalized.module
				: typeof normalized.service === 'string'
					? normalized.service
					: undefined;
	}

	delete normalized.logCategory;

	return sanitizeLogValue(normalized, new WeakSet<object>()) as Record<string, unknown>;
}

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	if (typeof error === 'string') {
		return new Error(redactString(error));
	}

	if (isRecord(error)) {
		const message =
			typeof error.message === 'string'
				? error.message
				: typeof error.error === 'string'
					? error.error
					: JSON.stringify(sanitizeLogValue(error, new WeakSet<object>()));
		return new Error(redactString(message));
	}

	return new Error(redactString(String(error)));
}

function sanitizeError(error: Error): Record<string, unknown> {
	const serialized = stdSerializers.err(error) as Record<string, unknown>;
	if (!shouldIncludeErrorStack()) {
		delete serialized.stack;
	}
	return sanitizeLogValue(serialized, new WeakSet<object>()) as Record<string, unknown>;
}

function getBasePinoOptions(): LoggerOptions {
	return {
		level: getRuntimeEnv('LOG_LEVEL') || (isDev() ? 'debug' : 'info'),
		base: {
			service: 'cinephage',
			env: getRuntimeEnv('NODE_ENV') || 'development',
			version: resolveLogVersion()
		},
		timestamp: pino.stdTimeFunctions.isoTime,
		messageKey: 'msg',
		formatters: {
			level(label) {
				return { level: label };
			}
		},
		serializers: {
			err: (error: Error) => sanitizeError(toError(error))
		},
		redact: {
			paths: [
				'req.headers.authorization',
				'req.headers.cookie',
				'req.headers["x-api-key"]',
				'headers.authorization',
				'headers.cookie',
				'headers["x-api-key"]',
				'apiKey',
				'token',
				'password',
				'secret'
			],
			censor: REDACTED,
			remove: false
		}
	};
}

async function createRootPinoLogger(): Promise<PinoLogger> {
	const options = getBasePinoOptions();

	if (import.meta.env?.SSR && isDev()) {
		const { createRequire } = await import('node:module');

		return pino(
			options,
			pino.transport({
				target: createRequire(import.meta.url).resolve('pino-pretty'),
				options: {
					colorize: true,
					translateTime: 'SYS:standard',
					ignore: 'pid,hostname'
				}
			})
		);
	}

	return pino(options);
}

const rootPinoLogger = await createRootPinoLogger();

let asyncLocalStorage: NodeAsyncLocalStorage<LogStore> | null = null;
let logCaptureStore: {
	append(entry: Omit<CapturedLogEntry, 'id'>): CapturedLogEntry;
} | null = null;
let logHistoryService: {
	append(entry: CapturedLogEntry): void;
} | null = null;

if (import.meta.env?.SSR) {
	const { AsyncLocalStorage } = await import('node:async_hooks');
	asyncLocalStorage = new AsyncLocalStorage<LogStore>();
}

export function registerServerLogSinks(sinks: {
	logCaptureStore?: {
		append(entry: Omit<CapturedLogEntry, 'id'>): CapturedLogEntry;
	};
	logHistoryService?: {
		append(entry: CapturedLogEntry): void;
	};
}): void {
	if (sinks.logCaptureStore) {
		logCaptureStore = sinks.logCaptureStore;
	}
	if (sinks.logHistoryService) {
		logHistoryService = sinks.logHistoryService;
	}
}

function getActiveStore(): LogStore | null {
	return asyncLocalStorage?.getStore() ?? null;
}

function getActivePinoLogger(): PinoLogger {
	return getActiveStore()?.logger ?? rootPinoLogger;
}

function normalizeObjectPayload(
	payload: Record<string, unknown>,
	level: LogLevel
): Record<string, unknown> {
	const normalized = sanitizeContext(payload as LogContext);
	const errorCandidate = normalized.err ?? normalized.error;
	if (level === 'error' && errorCandidate !== undefined && normalized.err === undefined) {
		normalized.err = sanitizeError(toError(errorCandidate));
		delete normalized.error;
	}
	return normalized;
}

function normalizeMessage(input: unknown): string | undefined {
	if (typeof input === 'string') {
		return redactString(input);
	}
	if (input === undefined) {
		return undefined;
	}
	return redactString(String(input));
}

function extractStringField(
	record: Record<string, unknown> | undefined,
	key: string
): string | undefined {
	const value = record?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function prepareLogEvent(level: LogLevel, args: unknown[]): PreparedLogEvent {
	if (level === 'error') {
		const [first, second, third] = args;

		if (typeof first === 'string') {
			const message = redactString(first);
			if (third !== undefined) {
				const payload = sanitizeContext((third as LogContext) ?? {});
				if (second !== undefined) {
					payload.err = sanitizeError(toError(second));
				}
				return { payload, message };
			}

			if (second instanceof Error) {
				return { payload: { err: sanitizeError(second) }, message };
			}

			if (isRecord(second)) {
				return { payload: normalizeObjectPayload(second, 'error'), message };
			}

			if (second !== undefined) {
				return { payload: { err: sanitizeError(toError(second)) }, message };
			}

			return { message };
		}

		if (isRecord(first)) {
			return { payload: normalizeObjectPayload(first, 'error'), message: normalizeMessage(second) };
		}

		return {
			payload: { err: sanitizeError(toError(first)) },
			message: normalizeMessage(second)
		};
	}

	const [first, second] = args;
	if (typeof first === 'string') {
		if (isRecord(second)) {
			return { payload: normalizeObjectPayload(second, level), message: redactString(first) };
		}
		return { message: redactString(first) };
	}

	if (isRecord(first)) {
		return { payload: normalizeObjectPayload(first, level), message: normalizeMessage(second) };
	}

	return { message: normalizeMessage(first) };
}

function captureLogEvent(level: LogLevel, event: PreparedLogEvent): void {
	if (!import.meta.env?.SSR) {
		return;
	}

	if (!logCaptureStore) {
		return;
	}

	const payload = event.payload;
	const rawErr = payload?.err;
	const err = isRecord(rawErr)
		? rawErr instanceof Error
			? sanitizeError(rawErr)
			: (rawErr as Record<string, unknown>)
		: undefined;

	// Keys that are promoted to top-level CapturedLogEntry fields — exclude from `data`
	const METADATA_KEYS = new Set([
		'err',
		'msg',
		'message',
		'logDomain',
		'logCategory',
		'domain',
		'component',
		'module',
		'service',
		'requestId',
		'correlationId',
		'supportId',
		'path',
		'method'
	]);

	const data = payload
		? Object.fromEntries(Object.entries(payload).filter(([key]) => !METADATA_KEYS.has(key)))
		: undefined;

	const entry: Omit<CapturedLogEntry, 'id'> = {
		timestamp: new Date().toISOString(),
		level,
		msg:
			event.message ??
			extractStringField(payload, 'msg') ??
			extractStringField(payload, 'message') ??
			'',
		logDomain: extractStringField(payload, 'logDomain') as CapturedLogEntry['logDomain'],
		component: extractStringField(payload, 'component'),
		module: extractStringField(payload, 'module'),
		service: extractStringField(payload, 'service'),
		requestId: extractStringField(payload, 'requestId'),
		correlationId: extractStringField(payload, 'correlationId'),
		supportId: extractStringField(payload, 'supportId'),
		path: extractStringField(payload, 'path'),
		method: extractStringField(payload, 'method'),
		data: data && Object.keys(data).length > 0 ? data : undefined,
		err
	};

	const capturedEntry = logCaptureStore.append(entry);
	logHistoryService?.append(capturedEntry);
}

function logWithArgs(
	pinoLogger: PinoLogger,
	level: LogLevel,
	args: unknown[],
	sanitizedBindings: LogContext,
	pinnedLogger: boolean
): void {
	// If the logger is pinned (already has bindings baked in), don't create another child.
	// Unpinned loggers (bare `logger` singleton) need a throwaway child for Pino output.
	const boundLogger =
		!pinnedLogger && Object.keys(sanitizedBindings).length
			? pinoLogger.child(sanitizedBindings)
			: pinoLogger;
	const prepared = prepareLogEvent(level, args);

	// Merge pre-sanitized bindings so capture store gets full context.
	// Per-call fields take priority over bindings (spread order).
	if (pinnedLogger && Object.keys(sanitizedBindings).length > 0) {
		prepared.payload = { ...sanitizedBindings, ...prepared.payload };
	}

	captureLogEvent(level, prepared);

	if (level === 'error') {
		if (prepared.payload && prepared.message !== undefined) {
			boundLogger.error(prepared.payload, prepared.message);
			return;
		}

		if (prepared.payload) {
			boundLogger.error(prepared.payload);
			return;
		}

		boundLogger.error(prepared.message);
		return;
	}

	if (prepared.payload && prepared.message !== undefined) {
		boundLogger[level](prepared.payload, prepared.message);
		return;
	}

	if (prepared.payload) {
		boundLogger[level](prepared.payload);
		return;
	}

	boundLogger[level](prepared.message);
}

class PinoAppLogger implements AppLogger {
	private readonly sanitizedBindings: LogContext;

	constructor(
		private readonly bindings: LogContext = {},
		private readonly pinnedLogger?: PinoLogger
	) {
		this.sanitizedBindings = Object.keys(bindings).length > 0 ? sanitizeContext(bindings) : {};
	}

	private getLogger(): PinoLogger {
		return this.pinnedLogger ?? getActivePinoLogger();
	}

	private isPinned(): boolean {
		return this.pinnedLogger !== undefined;
	}

	debug(messageOrContext: string | LogPayload, context?: LogContext | string): void {
		logWithArgs(
			this.getLogger(),
			'debug',
			[messageOrContext, context],
			this.sanitizedBindings,
			this.isPinned()
		);
	}

	info(messageOrContext: string | LogPayload, context?: LogContext | string): void {
		logWithArgs(
			this.getLogger(),
			'info',
			[messageOrContext, context],
			this.sanitizedBindings,
			this.isPinned()
		);
	}

	warn(messageOrContext: string | LogPayload, context?: LogContext | string): void {
		logWithArgs(
			this.getLogger(),
			'warn',
			[messageOrContext, context],
			this.sanitizedBindings,
			this.isPinned()
		);
	}

	error(
		messageOrContext: string | LogPayload,
		errorOrMessage?: unknown,
		context?: LogContext
	): void {
		logWithArgs(
			this.getLogger(),
			'error',
			[messageOrContext, errorOrMessage, context],
			this.sanitizedBindings,
			this.isPinned()
		);
	}

	child(bindings: LogContext): AppLogger {
		return new PinoAppLogger({ ...this.bindings, ...bindings }, this.pinnedLogger);
	}

	toPino(): PinoLogger {
		return Object.keys(this.sanitizedBindings).length
			? this.getLogger().child(this.sanitizedBindings)
			: this.getLogger();
	}
}

export const logger: AppLogger = new PinoAppLogger();

export function createChildLogger(baseContext: LogContext): AppLogger {
	const pinoLogger = rootPinoLogger.child(sanitizeContext(baseContext));
	return new PinoAppLogger(baseContext, pinoLogger);
}

export function createRequestLogger(baseContext: LogContext): AppLogger {
	const pinoLogger = rootPinoLogger.child(sanitizeContext(baseContext));
	return new PinoAppLogger(baseContext, pinoLogger);
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
	const parentLogger = getActivePinoLogger();
	const normalizedContext = sanitizeContext(context);
	const scopedLogger = parentLogger.child(normalizedContext);
	const store: LogStore = {
		logger: scopedLogger,
		requestId:
			typeof normalizedContext.requestId === 'string' ? normalizedContext.requestId : undefined,
		supportId:
			typeof normalizedContext.supportId === 'string' ? normalizedContext.supportId : undefined
	};

	if (!asyncLocalStorage) {
		return callback();
	}

	return asyncLocalStorage.run(store, callback);
}

export function getRequestLogger(): AppLogger {
	const store = getActiveStore();
	const bindings: LogContext = {};
	if (store?.requestId) bindings.requestId = store.requestId;
	if (store?.supportId) bindings.supportId = store.supportId;
	return new PinoAppLogger(bindings, store?.logger ?? getActivePinoLogger());
}

export function getRequestId(): string | undefined {
	return getActiveStore()?.requestId;
}

export function getSupportId(): string | undefined {
	return getActiveStore()?.supportId;
}
