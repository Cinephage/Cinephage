/**
 * Test Live TV Account Configuration API
 *
 * POST /api/livetv/accounts/test - Test a new account configuration (without saving)
 */

import type { RequestHandler } from './$types';
import { getProvider } from '#lib/server/livetv/providers/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { toFriendlyLiveTvTestError } from '#lib/livetv/errorMessages.js';
import { probeStalkerEndpoint } from '#lib/server/livetv/stalker/StalkerPortalClient.js';
import { getLiveTvAccountManager } from '#lib/server/livetv/LiveTvAccountManager.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { REDACTED_VALUE } from '#lib/shared/sensitiveSettings.js';
import { stalkerLanguageSchema } from '#lib/server/validation/schemas.js';
import { z } from 'zod';
import { ValidationError } from '#lib/errors/index.js';
import type { LiveTvAccount } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvAccountsTest', logDomain: 'livetv' });

// Validation schema for testing Live TV accounts
const liveTvAccountTestSchema = z.object({
	providerType: z.enum(['stalker', 'xstream', 'm3u', 'cinephage-iptv']),
	// When set, [REDACTED]/blank secrets above are resolved from this stored
	// account server-side so edit-mode tests work without the API ever
	// shipping the real credential to the client.
	accountId: z.string().optional(),
	// Stalker-specific config
	stalkerConfig: z
		.object({
			portalUrl: z.string().url(),
			macAddress: z.string().min(1),
			serialNumber: z.string().optional(),
			deviceId: z.string().optional(),
			deviceId2: z.string().optional(),
			model: z.string().optional(),
			timezone: z.string().optional(),
			language: stalkerLanguageSchema.optional(),
			username: z.string().optional(),
			password: z.string().optional()
		})
		.optional(),
	// XStream-specific config
	xstreamConfig: z
		.object({
			baseUrl: z.string().url('Please enter a valid server URL'),
			username: z.string().min(1, 'Username is required'),
			password: z.string().min(1, 'Password is required'),
			epgUrl: z.string().url().optional()
		})
		.optional(),
	// M3U-specific config (url/epgUrl accept the [REDACTED] marker echoed by
	// the edit form; headers can carry per-header redacted values)
	m3uConfig: z
		.object({
			url: z.union([z.string().url(), z.literal(REDACTED_VALUE)]).optional(),
			fileContent: z.string().optional(),
			epgUrl: z.union([z.string().url(), z.literal(REDACTED_VALUE)]).optional(),
			headers: z.record(z.string(), z.string()).optional(),
			userAgent: z.string().optional()
		})
		.optional(),
	// Cinephage IPTV config
	cinephageIptvConfig: z
		.object({
			countries: z.array(z.string()).optional(),
			categories: z.array(z.string()).optional(),
			languages: z.array(z.string()).optional()
		})
		.optional()
});

/**
 * Build a user-friendly validation error message from flattened Zod errors.
 */
function getFriendlyValidationMessage(error: ValidationError): string {
	const details = (error.context?.details ?? null) as {
		formErrors?: string[];
		fieldErrors?: Record<string, string[] | undefined>;
	} | null;

	const formError = details?.formErrors?.find(
		(message) => typeof message === 'string' && message.length > 0
	);
	if (formError) {
		return formError;
	}

	if (details?.fieldErrors) {
		const firstFieldWithError = Object.entries(details.fieldErrors).find(
			([, messages]) => Array.isArray(messages) && messages.length > 0
		);

		if (firstFieldWithError) {
			const [field, messages] = firstFieldWithError;
			const firstMessage = messages?.[0];
			if (firstMessage) {
				const hasSchemaInternals =
					firstMessage.includes('Too small:') ||
					firstMessage.includes('Invalid input:') ||
					firstMessage.includes('expected string');
				if (!hasSchemaInternals) {
					return firstMessage;
				}

				if (field === 'xstreamConfig') {
					return 'Please enter a valid server URL, username, and password.';
				}
				if (field === 'stalkerConfig') {
					return 'Please enter a valid portal URL and MAC address.';
				}
				if (field === 'm3uConfig') {
					return 'Please provide a valid M3U URL or playlist content.';
				}
				const friendlyField = field
					.replace(/([a-z])([A-Z])/g, '$1 $2')
					.replace(/Config$/, ' configuration')
					.toLowerCase();

				return `Please check ${friendlyField}: ${firstMessage}`;
			}
		}
	}

	return 'Please review the account fields and try again.';
}

/**
 * Test a Live TV account configuration without saving
 * Useful for validating credentials before creating an account
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	let providerType: LiveTvAccount['providerType'] | undefined;

	try {
		const body = await event.request.json();
		providerType =
			typeof body === 'object' && body && 'providerType' in body
				? ((body as { providerType?: LiveTvAccount['providerType'] }).providerType ?? undefined)
				: undefined;

		// Validate input
		const parsed = liveTvAccountTestSchema.safeParse(body);
		if (!parsed.success) {
			throw new ValidationError('Validation failed', {
				details: parsed.error.flatten()
			});
		}

		// Resolve [REDACTED] secrets from the stored account: edit-mode tests
		// arrive with the redaction marker in place of the credential.
		if (parsed.data.accountId) {
			const manager = getLiveTvAccountManager();
			const stored = await manager.getAccount(parsed.data.accountId);
			if (!stored) {
				return Response.json({ success: false, error: 'Account not found' }, { status: 404 });
			}
			if (
				parsed.data.xstreamConfig &&
				(!parsed.data.xstreamConfig.password ||
					parsed.data.xstreamConfig.password === REDACTED_VALUE)
			) {
				parsed.data.xstreamConfig.password = stored.xstreamConfig?.password ?? '';
			}
			if (parsed.data.xstreamConfig && parsed.data.xstreamConfig.epgUrl === REDACTED_VALUE) {
				parsed.data.xstreamConfig.epgUrl = stored.xstreamConfig?.epgUrl;
			}
			if (
				parsed.data.stalkerConfig &&
				(!parsed.data.stalkerConfig.password ||
					parsed.data.stalkerConfig.password === REDACTED_VALUE)
			) {
				parsed.data.stalkerConfig.password = stored.stalkerConfig?.password;
			}
			if (parsed.data.m3uConfig) {
				if (parsed.data.m3uConfig.url === REDACTED_VALUE) {
					parsed.data.m3uConfig.url = stored.m3uConfig?.url;
				}
				if (parsed.data.m3uConfig.epgUrl === REDACTED_VALUE) {
					parsed.data.m3uConfig.epgUrl = stored.m3uConfig?.epgUrl;
				}
				const headers = parsed.data.m3uConfig.headers;
				if (headers && Object.values(headers).some((v) => v === REDACTED_VALUE)) {
					parsed.data.m3uConfig.headers = stored.m3uConfig?.headers;
				}
			}
		}

		// Build temporary account for testing
		const tempAccount: LiveTvAccount = {
			id: 'test',
			name: 'Test Account',
			providerType: parsed.data.providerType,
			enabled: true,
			stalkerConfig: parsed.data.stalkerConfig,
			xstreamConfig: parsed.data.xstreamConfig,
			m3uConfig: parsed.data.m3uConfig,
			cinephageIptvConfig: parsed.data.cinephageIptvConfig,

			playbackLimit: null,
			channelCount: null,
			categoryCount: null,
			expiresAt: null,
			serverTimezone: null,
			lastTestedAt: null,
			lastTestSuccess: null,
			lastTestError: null,
			lastSyncAt: null,
			lastSyncError: null,
			syncStatus: 'never',
			lastEpgSyncAt: null,
			lastEpgSyncError: null,
			epgProgramCount: 0,
			hasEpg: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};

		// Probe stalker endpoint before testing so the client uses the correct one
		if (tempAccount.stalkerConfig?.portalUrl) {
			tempAccount.stalkerConfig = {
				...tempAccount.stalkerConfig,
				endpoint: await probeStalkerEndpoint(tempAccount.stalkerConfig.portalUrl)
			};
		}

		// Get provider and test
		const provider = getProvider(parsed.data.providerType);
		const providerResult = await provider.testConnection(tempAccount);
		const result = providerResult.success
			? providerResult
			: {
					...providerResult,
					error: toFriendlyLiveTvTestError(providerResult.error, parsed.data.providerType)
				};

		return Response.json({
			success: true,
			result
		});
	} catch (error) {
		// Validation errors
		if (error instanceof ValidationError) {
			logger.warn(
				{
					code: error.code,
					statusCode: error.statusCode
				},
				'[API] Live TV account test rejected due to invalid input'
			);

			return Response.json(
				{
					success: false,
					error: getFriendlyValidationMessage(error),
					code: error.code,
					context: error.context
				},
				{ status: error.statusCode }
			);
		}

		logger.error(
			'[API] Failed to test Live TV account configuration',
			error instanceof Error ? error : undefined
		);

		return Response.json(
			{
				success: false,
				error: toFriendlyLiveTvTestError(
					error instanceof Error ? error.message : 'Failed to test account configuration',
					providerType
				)
			},
			{ status: 500 }
		);
	}
};
