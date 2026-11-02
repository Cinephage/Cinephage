import { and, eq, like, desc, asc, notInArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { authApiKeys, user, userApiKeySecrets } from '#lib/server/db/schema.js';
import { decryptApiKey } from '#lib/server/crypto/apiKeyCrypto.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';

/** AAD purpose for recoverable API-key secrets at rest. */
const USER_API_KEY_PURPOSE = 'user-api-key';

function encryptRecoverableKey(keyId: string, plainKey: string): string {
	return encryptCredential(USER_API_KEY_PURPOSE, keyId, plainKey);
}

function decryptRecoverableKey(keyId: string, stored: string): string | null {
	if (isEncryptedCredential(stored)) {
		return decryptCredential(USER_API_KEY_PURPOSE, keyId, stored, `api-key:${keyId}`);
	}
	// Legacy `iv:tag:ct` blobs from apiKeyCrypto (pre-migration 161).
	return decryptApiKey(stored);
}
import { auth } from './auth.js';

type KeyCreationResult = {
	id: string;
	key: string;
};

export type ManagedApiKeyType = 'main' | 'streaming';

type ApiKeyPermissions = Record<string, string[]>;

/** What auth.api.createApiKey actually returns — inferred, no hand-mirror. */
type CreatedApiKey = Awaited<ReturnType<typeof auth.api.createApiKey>>;

const DEFAULT_STREAMING_API_KEY_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60;
const DEFAULT_STREAMING_API_KEY_RATE_LIMIT_MAX = 10000;

function getPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return fallback;
	}

	return parsed;
}

const STREAMING_API_KEY_RATE_LIMIT_WINDOW_MS = getPositiveIntegerEnv(
	'STREAMING_API_KEY_RATE_LIMIT_WINDOW_MS',
	DEFAULT_STREAMING_API_KEY_RATE_LIMIT_WINDOW_MS
);
const STREAMING_API_KEY_RATE_LIMIT_MAX = getPositiveIntegerEnv(
	'STREAMING_API_KEY_RATE_LIMIT_MAX',
	DEFAULT_STREAMING_API_KEY_RATE_LIMIT_MAX
);

/** Shape of a key as returned by auth.api.listApiKeys — inferred, no hand-mirror. */
type ListedApiKey = Awaited<ReturnType<typeof auth.api.listApiKeys>>['apiKeys'][number];

export type RecoverableApiKey = {
	id: string;
	name?: string | null;
	key: string;
	createdAt?: Date | string | null;
	metadata?: Record<string, unknown> | null;
};

function isManagedApiKeyType(
	key: { metadata?: Record<string, unknown> | null } | null | undefined,
	type: ManagedApiKeyType
): boolean {
	return key?.metadata?.type === type;
}

function formatRecoverableApiKey(
	key: ListedApiKey | CreatedApiKey | null,
	recoveredKey: string | null
): RecoverableApiKey | null {
	if (!key) {
		return null;
	}

	return {
		id: key.id,
		name: key.name ?? null,
		key:
			recoveredKey ||
			('key' in key ? key.key : undefined) ||
			`${key.prefix || 'cinephage'}_${key.start || ''}...`,
		createdAt: key.createdAt,
		metadata: key.metadata ?? null
	};
}

export async function upsertRecoverableApiKeySecret(
	keyId: string,
	userId: string,
	plainKey: string
): Promise<void> {
	const encryptedKey = encryptRecoverableKey(keyId, plainKey);
	const createdAt = new Date().toISOString();

	await db
		.insert(userApiKeySecrets)
		.values({
			id: keyId,
			userId,
			encryptedKey,
			createdAt
		})
		.onConflictDoUpdate({
			target: userApiKeySecrets.id,
			set: {
				userId,
				encryptedKey,
				createdAt
			}
		});
}

export async function getRecoverableApiKeyValue(keyId: string): Promise<string | null> {
	const keyRecord = await db.query.userApiKeySecrets.findFirst({
		where: eq(userApiKeySecrets.id, keyId)
	});

	return keyRecord ? decryptRecoverableKey(keyRecord.id, keyRecord.encryptedKey) : null;
}

export async function createRecoverableApiKey(options: {
	userId: string;
	name: string;
	metadata: Record<string, unknown>;
	permissions: ApiKeyPermissions;
}): Promise<CreatedApiKey> {
	const apiKey = await auth.api.createApiKey({
		body: {
			userId: options.userId,
			name: options.name,
			metadata: options.metadata,
			permissions: options.permissions,
			rateLimitEnabled: options.metadata.type === 'streaming',
			rateLimitTimeWindow:
				options.metadata.type === 'streaming' ? STREAMING_API_KEY_RATE_LIMIT_WINDOW_MS : undefined,
			rateLimitMax:
				options.metadata.type === 'streaming' ? STREAMING_API_KEY_RATE_LIMIT_MAX : undefined
		}
	});

	if (!apiKey.key) {
		throw new Error('Better Auth did not return a recoverable API key value');
	}

	await upsertRecoverableApiKeySecret(apiKey.id, options.userId, apiKey.key);

	return apiKey;
}

export async function ensureStreamingApiKeyRateLimit(userId?: string): Promise<number> {
	const conditions = [
		eq(authApiKeys.enabled, 1),
		like(authApiKeys.metadata, '%"type":"streaming"%')
	];

	if (userId) {
		conditions.push(eq(authApiKeys.referenceId, userId));
	}

	const result = await db
		.update(authApiKeys)
		.set({
			rateLimitEnabled: 1,
			rateLimitTimeWindow: STREAMING_API_KEY_RATE_LIMIT_WINDOW_MS,
			rateLimitMax: STREAMING_API_KEY_RATE_LIMIT_MAX,
			requestCount: 0,
			remaining: null,
			lastRequest: null
		})
		.where(and(...conditions))
		.returning({ id: authApiKeys.id });

	return result.length;
}

/**
 * Enable or disable every API key owned by an account. The ban flow uses this
 * to neutralize keys (verifyApiKey rejects disabled keys immediately, closing
 * the streaming surface that sessions-based revocation never covered); unbans
 * re-enable them. Idempotent by design — managed keys have no other disabled
 * state in this app, so re-running on unrelated user updates is a no-op.
 */
export async function setManagedApiKeysEnabled(userId: string, enabled: boolean): Promise<number> {
	const result = await db
		.update(authApiKeys)
		.set({ enabled: enabled ? 1 : 0 })
		.where(eq(authApiKeys.referenceId, userId))
		.returning({ id: authApiKeys.id });

	return result.length;
}

export async function ensureDefaultApiKeysForUser(
	userId: string,
	headers: Headers
): Promise<{
	mainKey: KeyCreationResult | null;
	streamingKey: KeyCreationResult | null;
}> {
	const apiKeysResult = await auth.api.listApiKeys({
		headers
	});
	const existingKeys = apiKeysResult.apiKeys;

	const hasMainKey = existingKeys.some((key) => isManagedApiKeyType(key, 'main'));
	const hasStreamingKey = existingKeys.some((key) => isManagedApiKeyType(key, 'streaming'));

	const result = {
		mainKey: null as KeyCreationResult | null,
		streamingKey: null as KeyCreationResult | null
	};

	if (!hasMainKey) {
		const mainKey = await createRecoverableApiKey({
			userId,
			name: 'Main API Key',
			metadata: {
				type: 'main',
				description: 'Full access to all API endpoints'
			},
			permissions: {
				default: ['*']
			}
		});

		result.mainKey = {
			id: mainKey.id,
			key: mainKey.key || ''
		};
	}

	if (!hasStreamingKey) {
		const streamingKey = await createRecoverableApiKey({
			userId,
			name: 'Media Streaming API Key',
			metadata: {
				type: 'streaming',
				description: 'Access to Live TV and Media Streaming endpoints for media server integration'
			},
			permissions: {
				livetv: ['*'],
				streaming: ['*']
			}
		});

		result.streamingKey = {
			id: streamingKey.id,
			key: streamingKey.key || ''
		};
	}

	return result;
}

export async function regenerateRecoverableApiKey(options: {
	keyId: string;
	userId: string;
	headers: Headers;
}): Promise<RecoverableApiKey | null> {
	const existingKey = await auth.api.getApiKey({
		query: { id: options.keyId },
		headers: options.headers
	});

	if (!existingKey || existingKey.referenceId !== options.userId) {
		return null;
	}

	await auth.api.deleteApiKey({
		body: { keyId: options.keyId },
		headers: options.headers
	});
	await db
		.delete(userApiKeySecrets)
		.where(
			and(
				eq(userApiKeySecrets.userId, options.userId),
				notInArray(userApiKeySecrets.id, db.select({ id: authApiKeys.id }).from(authApiKeys))
			)
		);

	const newKey = await createRecoverableApiKey({
		userId: options.userId,
		name: existingKey.name || 'API Key',
		metadata: existingKey.metadata || {},
		permissions: existingKey.permissions || { default: ['*'] }
	});

	// Regeneration must not resurrect a banned account's credentials: the ban
	// hook disables every owned key, and a fresh row would otherwise come back
	// enabled because createApiKey has no ban awareness.
	const [owner] = await db
		.select({ banned: user.banned })
		.from(user)
		.where(eq(user.id, options.userId))
		.limit(1);
	if (owner?.banned) {
		await db.update(authApiKeys).set({ enabled: 0 }).where(eq(authApiKeys.id, newKey.id));
	}

	return formatRecoverableApiKey(newKey, newKey.key || null);
}

export async function getManagedApiKeysForRequest(headers: Headers): Promise<{
	mainApiKey: RecoverableApiKey | null;
	streamingApiKey: RecoverableApiKey | null;
}> {
	const apiKeysResult = await auth.api.listApiKeys({
		headers
	});
	const mainApiKey = apiKeysResult.apiKeys.find((key) => isManagedApiKeyType(key, 'main')) || null;
	const streamingApiKey =
		apiKeysResult.apiKeys.find((key) => isManagedApiKeyType(key, 'streaming')) || null;

	const [mainKeyValue, streamingKeyValue] = await Promise.all([
		mainApiKey ? getRecoverableApiKeyValue(mainApiKey.id) : Promise.resolve(null),
		streamingApiKey ? getRecoverableApiKeyValue(streamingApiKey.id) : Promise.resolve(null)
	]);

	return {
		mainApiKey: formatRecoverableApiKey(mainApiKey, mainKeyValue),
		streamingApiKey: formatRecoverableApiKey(streamingApiKey, streamingKeyValue)
	};
}

/**
 * Recover a managed key's plaintext. With userId this returns that account's
 * most recent matching key. Without userId it falls back to the most recent
 * matching key of ANY account — only correct while a single admin exists.
 */
export async function getRecoverableApiKeyByType(
	type: ManagedApiKeyType,
	userId?: string
): Promise<string | null> {
	const conditions = [eq(authApiKeys.enabled, 1), like(authApiKeys.metadata, `%"type":"${type}"%`)];

	if (userId) {
		conditions.push(eq(authApiKeys.referenceId, userId));
	}

	const [result] = await db
		.select({
			id: userApiKeySecrets.id,
			encryptedKey: userApiKeySecrets.encryptedKey
		})
		.from(authApiKeys)
		.innerJoin(userApiKeySecrets, eq(userApiKeySecrets.id, authApiKeys.id))
		.where(and(...conditions))
		.orderBy(desc(authApiKeys.createdAt))
		.limit(1);

	return result ? decryptRecoverableKey(result.id, result.encryptedKey) : null;
}

/**
 * The instance-level streaming key for background jobs with no user session
 * (STRM generation, streaming availability checks). Deterministically the
 * oldest admin's key — the owner account — so multi-user instances always
 * stamp .strm files and stream checks with the same, stable credential.
 */
export async function getOwnerStreamingApiKey(): Promise<string | null> {
	const [owner] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.role, 'admin'))
		.orderBy(asc(user.createdAt))
		.limit(1);

	if (!owner) {
		return getRecoverableApiKeyByType('streaming');
	}
	return getRecoverableApiKeyByType('streaming', owner.id);
}
