/**
 * Live TV Account by ID API
 *
 * GET    /api/livetv/accounts/[id] - Get account by ID
 * PUT    /api/livetv/accounts/[id] - Update account
 * DELETE /api/livetv/accounts/[id] - Delete account
 */

import type { RequestHandler } from './$types';
import { getLiveTvAccountManager } from '#lib/server/livetv/LiveTvAccountManager.js';
import { redactAccountSecrets } from '#lib/server/livetv/accountRedaction.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getEpgService, getEpgScheduler } from '#lib/server/livetv/epg/index.js';
import { getEpgSyncState } from '#lib/server/livetv/epg/EpgSyncState.js';
import { liveTvEvents } from '#lib/server/livetv/LiveTvEvents.js';
import { createChildLogger } from '#lib/logging/index.js';
import { z } from 'zod';
import { ValidationError } from '#lib/errors/index.js';
import { REDACTED_VALUE } from '#lib/shared/sensitiveSettings.js';
import { stalkerLanguageSchema } from '#lib/server/validation/schemas.js';

const logger = createChildLogger({ module: 'LiveTvAccountById', logDomain: 'livetv' });

// Validation schema for updating Live TV accounts
const liveTvAccountUpdateSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	enabled: z.boolean().optional(),
	// Stalker-specific config updates
	stalkerConfig: z
		.object({
			portalUrl: z.string().url().optional(),
			macAddress: z.string().min(1).optional(),
			serialNumber: z.string().optional(),
			deviceId: z.string().optional(),
			deviceId2: z.string().optional(),
			model: z.string().optional(),
			timezone: z.string().optional(),
			language: stalkerLanguageSchema.optional(),
			username: z.string().optional(),
			password: z.string().optional(),
			token: z.string().optional()
		})
		.optional(),
	// XStream-specific config updates
	xstreamConfig: z
		.object({
			baseUrl: z.string().url().optional(),
			username: z.string().min(1).optional(),
			password: z.string().min(1).optional(),
			authToken: z.string().optional(),
			epgUrl: z.preprocess(
				(value) => (typeof value === 'string' ? value.trim() : value),
				z.union([z.string().url(), z.literal(''), z.literal(REDACTED_VALUE)]).optional()
			)
		})
		.optional(),
	// M3U-specific config updates (url/epgUrl accept the [REDACTED] marker the
	// edit form echoes back for unchanged redacted values)
	m3uConfig: z
		.object({
			url: z.union([z.string().url(), z.literal(REDACTED_VALUE)]).optional(),
			fileContent: z.string().optional(),
			epgUrl: z.preprocess(
				(value) => (typeof value === 'string' ? value.trim() : value),
				z.union([z.string().url(), z.literal(''), z.literal(REDACTED_VALUE)]).optional()
			),
			headers: z.record(z.string(), z.string()).optional(),
			userAgent: z.string().optional(),
			refreshIntervalHours: z.number().min(1).max(168).optional(),
			autoRefresh: z.boolean().optional()
		})
		.optional(),
	// Cinephage IPTV config updates
	cinephageIptvConfig: z
		.object({
			countries: z.array(z.string()).optional(),
			categories: z.array(z.string()).optional(),
			languages: z.array(z.string()).optional()
		})
		.optional()
});

function queueAccountEpgSync(accountId: string): void {
	const syncState = getEpgSyncState();
	const epgScheduler = getEpgScheduler();

	if (epgScheduler.getStatus().isSyncing) {
		logger.info(
			{
				accountId
			},
			'[API] Skipping account EPG sync trigger because scheduler sync is already running'
		);
		return;
	}

	if (!syncState.tryStartAccount(accountId)) {
		logger.info(
			{
				accountId
			},
			'[API] Skipping account EPG sync trigger because another EPG sync is already running'
		);
		return;
	}

	setImmediate(async () => {
		try {
			const epgService = getEpgService();
			liveTvEvents.emitEpgSyncStarted(accountId);
			const result = await epgService.syncAccount(accountId, {
				shouldCancel: () => syncState.isCancelRequestedForAccount(accountId)
			});

			if (result.success) {
				liveTvEvents.emitEpgSyncCompleted(accountId);
				logger.info({ accountId }, '[API] Background EPG sync complete after account update');
			} else {
				const errorMessage = result.error ?? 'EPG sync failed';
				liveTvEvents.emitEpgSyncFailed(accountId, errorMessage);
				logger.warn(
					{ accountId, error: errorMessage },
					'[API] Background EPG sync finished with failure after account update'
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			liveTvEvents.emitEpgSyncFailed(accountId, message);
			logger.error(
				{
					accountId,
					error: message
				},
				'[API] Background EPG sync failed after account update'
			);
		} finally {
			syncState.finishAccount(accountId);
		}
	});
}

/**
 * Get a Live TV account by ID
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const manager = getLiveTvAccountManager();
		const account = await manager.getAccount(event.params.id);

		if (!account) {
			return Response.json(
				{
					success: false,
					error: 'Account not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			account: redactAccountSecrets(account)
		});
	} catch (error) {
		logger.error('[API] Failed to get Live TV account', error instanceof Error ? error : undefined);

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get account'
			},
			{ status: 500 }
		);
	}
};

/**
 * Update a Live TV account
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { params, request } = event;
	try {
		const body = await request.json();

		// Validate input
		const parsed = liveTvAccountUpdateSchema.safeParse(body);
		if (!parsed.success) {
			throw new ValidationError('Validation failed', {
				details: parsed.error.flatten()
			});
		}

		const updates = parsed.data;
		const hasExplicitM3uEpgField =
			typeof body === 'object' &&
			body !== null &&
			'm3uConfig' in body &&
			typeof body.m3uConfig === 'object' &&
			body.m3uConfig !== null &&
			Object.prototype.hasOwnProperty.call(body.m3uConfig, 'epgUrl');
		const requestedM3uEpgUrl =
			hasExplicitM3uEpgField &&
			typeof body.m3uConfig === 'object' &&
			body.m3uConfig !== null &&
			typeof body.m3uConfig.epgUrl === 'string' &&
			body.m3uConfig.epgUrl !== REDACTED_VALUE
				? body.m3uConfig.epgUrl.trim()
				: null;

		const hasExplicitXstreamEpgField =
			typeof body === 'object' &&
			body !== null &&
			'xstreamConfig' in body &&
			typeof body.xstreamConfig === 'object' &&
			body.xstreamConfig !== null &&
			Object.prototype.hasOwnProperty.call(body.xstreamConfig, 'epgUrl');
		const requestedXstreamEpgUrl =
			hasExplicitXstreamEpgField &&
			typeof body.xstreamConfig === 'object' &&
			body.xstreamConfig !== null &&
			typeof body.xstreamConfig.epgUrl === 'string' &&
			body.xstreamConfig.epgUrl !== REDACTED_VALUE
				? body.xstreamConfig.epgUrl.trim()
				: null;

		// Empty epgUrl in update payload means "clear existing epgUrl".
		if (hasExplicitM3uEpgField && updates.m3uConfig && updates.m3uConfig.epgUrl === '') {
			updates.m3uConfig.epgUrl = undefined;
		}
		if (
			hasExplicitXstreamEpgField &&
			updates.xstreamConfig &&
			updates.xstreamConfig.epgUrl === ''
		) {
			updates.xstreamConfig.epgUrl = undefined;
		}

		// A [REDACTED] secret from the edit form means "unchanged" — drop it so
		// the merge keeps the stored credential instead of overwriting it with
		// the marker.
		if (updates.xstreamConfig?.password === REDACTED_VALUE) {
			updates.xstreamConfig = { ...updates.xstreamConfig };
			delete updates.xstreamConfig.password;
		}
		if (updates.stalkerConfig?.password === REDACTED_VALUE) {
			updates.stalkerConfig = { ...updates.stalkerConfig };
			delete updates.stalkerConfig.password;
		}
		// Redaction is symmetric for every secret the API redacts: an echoed
		// marker means "unchanged", never "overwrite with [REDACTED]".
		if (updates.xstreamConfig?.authToken === REDACTED_VALUE) {
			updates.xstreamConfig = { ...updates.xstreamConfig };
			delete updates.xstreamConfig.authToken;
		}
		if (updates.stalkerConfig?.token === REDACTED_VALUE) {
			updates.stalkerConfig = { ...updates.stalkerConfig };
			delete updates.stalkerConfig.token;
		}
		// Newly redacted fields (url/headers embed credentials; epgUrl may):
		// echoed markers mean "unchanged".
		if (updates.m3uConfig?.url === REDACTED_VALUE) {
			updates.m3uConfig = { ...updates.m3uConfig };
			delete updates.m3uConfig.url;
		}
		if (updates.m3uConfig?.epgUrl === REDACTED_VALUE) {
			updates.m3uConfig = { ...updates.m3uConfig };
			delete updates.m3uConfig.epgUrl;
		}
		if (
			updates.m3uConfig?.headers &&
			Object.values(updates.m3uConfig.headers).some((v) => v === REDACTED_VALUE)
		) {
			updates.m3uConfig = { ...updates.m3uConfig };
			delete updates.m3uConfig.headers;
		}
		if (updates.xstreamConfig?.epgUrl === REDACTED_VALUE) {
			updates.xstreamConfig = { ...updates.xstreamConfig };
			delete updates.xstreamConfig.epgUrl;
		}

		const manager = getLiveTvAccountManager();
		const existingAccount = await manager.getAccount(params.id);
		if (!existingAccount) {
			return Response.json(
				{
					success: false,
					error: 'Account not found'
				},
				{ status: 404 }
			);
		}

		const previousM3uEpgUrl = (existingAccount.m3uConfig?.epgUrl ?? '').trim();
		const shouldTriggerM3uEpgSync =
			hasExplicitM3uEpgField &&
			existingAccount.providerType === 'm3u' &&
			requestedM3uEpgUrl !== null &&
			previousM3uEpgUrl !== requestedM3uEpgUrl;
		const previousXstreamEpgUrl = (existingAccount.xstreamConfig?.epgUrl ?? '').trim();
		const shouldTriggerXstreamEpgSync =
			hasExplicitXstreamEpgField &&
			existingAccount.providerType === 'xstream' &&
			requestedXstreamEpgUrl !== null &&
			previousXstreamEpgUrl !== requestedXstreamEpgUrl;
		const shouldTriggerAccountEpgSync = shouldTriggerM3uEpgSync || shouldTriggerXstreamEpgSync;
		const account = await manager.updateAccount(params.id, updates);

		if (!account) {
			return Response.json(
				{
					success: false,
					error: 'Account not found'
				},
				{ status: 404 }
			);
		}

		if (shouldTriggerAccountEpgSync && account.enabled) {
			queueAccountEpgSync(account.id);
		}

		return Response.json({
			success: true,
			account: redactAccountSecrets(account)
		});
	} catch (error) {
		logger.error(
			'[API] Failed to update Live TV account',
			error instanceof Error ? error : undefined
		);

		// Validation errors
		if (error instanceof ValidationError) {
			return Response.json(
				{
					success: false,
					error: error.message,
					code: error.code,
					context: error.context
				},
				{ status: error.statusCode }
			);
		}

		const message = error instanceof Error ? error.message : String(error);

		// Unique constraint violation
		if (message.includes('UNIQUE constraint failed')) {
			return Response.json(
				{
					success: false,
					error: 'An account with this configuration already exists'
				},
				{ status: 409 }
			);
		}

		return Response.json(
			{
				success: false,
				error: message || 'Failed to update account'
			},
			{ status: 500 }
		);
	}
};

/**
 * Delete a Live TV account
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const manager = getLiveTvAccountManager();
		const deleted = await manager.deleteAccount(event.params.id);

		if (!deleted) {
			return Response.json(
				{
					success: false,
					error: 'Account not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true
		});
	} catch (error) {
		logger.error(
			'[API] Failed to delete Live TV account',
			error instanceof Error ? error : undefined
		);

		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete account'
			},
			{ status: 500 }
		);
	}
};
