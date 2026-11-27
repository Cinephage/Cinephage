/**
 * "Sign in with Plex" as a better-auth plugin.
 *
 *   POST {AUTH_BASE_PATH}/plex/pin      -> { handle, authUrl, expiresAt }
 *   POST {AUTH_BASE_PATH}/plex/sign-in  { handle, rememberMe? }
 *        -> { status: 'pending' } | { status: 'expired' } | { status: 'signed-in' }
 *
 * The browser opens authUrl (Plex's own approval page) in a popup and
 * polls /plex/sign-in with the opaque handle. Once Plex reports the PIN
 * approved, this server reads the account identity with the token, drops
 * the token, decides the local account (plexSignIn.ts) and issues an
 * ordinary better-auth session - so bans, session revocation and cookie
 * handling behave exactly as for password sign-in.
 */

import { z } from 'zod';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { createChildLogger } from '#lib/logging/index.js';
import { plexPinService } from '#lib/server/mediaServerLink/PlexPinService.js';
import { fetchPlexAccount } from '#lib/server/mediaServerLink/plexTv.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';
import { resolvePlexSignIn } from './plexSignIn.js';
import { runTrustedProvisioning } from './provisioning.js';
import { isSetupComplete } from './setup.js';

const logger = createChildLogger({ module: 'PlexSignIn', logDomain: 'auth' });

export const PLEX_SIGN_IN_ERROR_CODES = {
	unavailable: 'PLEX_SIGN_IN_UNAVAILABLE',
	noAccess: 'PLEX_NO_ACCESS',
	notLinked: 'PLEX_NOT_LINKED',
	accountUnavailable: 'PLEX_ACCOUNT_UNAVAILABLE',
	ambiguous: 'PLEX_AMBIGUOUS_LINK',
	upstream: 'PLEX_UPSTREAM_ERROR'
} as const;

function refuse(status: 'FORBIDDEN' | 'CONFLICT' | 'BAD_GATEWAY', code: string, message: string) {
	return new APIError(status, { code, message });
}

async function assertAvailable(): Promise<void> {
	if (!(await isSetupComplete()) || !(await mediaServerLinkService.hasPlexSignInServer())) {
		throw refuse(
			'FORBIDDEN',
			PLEX_SIGN_IN_ERROR_CODES.unavailable,
			'Plex sign-in is not available.'
		);
	}
}

export const plexAuth = () =>
	({
		id: 'plex-auth',
		endpoints: {
			plexCreatePin: createAuthEndpoint('/plex/pin', { method: 'POST' }, async (ctx) => {
				await assertAvailable();
				try {
					const pin = await plexPinService.create({ kind: 'sign-in' });
					return ctx.json(pin);
				} catch (error) {
					logger.warn({ err: error }, '[PlexSignIn] PIN creation failed');
					throw refuse('BAD_GATEWAY', PLEX_SIGN_IN_ERROR_CODES.upstream, 'Could not reach Plex.');
				}
			}),

			plexSignIn: createAuthEndpoint(
				'/plex/sign-in',
				{
					method: 'POST',
					body: z.object({
						handle: z.string().min(1).max(128),
						rememberMe: z.boolean().optional()
					})
				},
				async (ctx) => {
					await assertAvailable();

					let poll;
					try {
						poll = await plexPinService.poll(ctx.body.handle, { kind: 'sign-in' });
					} catch (error) {
						logger.warn({ err: error }, '[PlexSignIn] PIN poll failed');
						throw refuse('BAD_GATEWAY', PLEX_SIGN_IN_ERROR_CODES.upstream, 'Could not reach Plex.');
					}
					if (poll.outcome !== 'authorized') {
						return ctx.json({ status: poll.outcome });
					}

					// Identity only: the token is not stored anywhere.
					let account;
					try {
						account = await fetchPlexAccount(poll.authToken);
					} catch (error) {
						logger.warn({ err: error }, '[PlexSignIn] Account lookup failed');
						throw refuse('BAD_GATEWAY', PLEX_SIGN_IN_ERROR_CODES.upstream, 'Could not reach Plex.');
					}
					if (!account) {
						return ctx.json({ status: 'expired' });
					}

					const decision = await resolvePlexSignIn(account);
					let userId: string;
					switch (decision.outcome) {
						case 'existing':
							userId = decision.userId;
							break;
						case 'provision': {
							userId = await runTrustedProvisioning('plex', async () => {
								const created = await ctx.context.internalAdapter.createUser(
									{
										email: decision.email,
										name: decision.username,
										username: decision.username,
										displayUsername: decision.username
									},
									{ method: 'plex' }
								);
								// No credential account: a Plex-provisioned account
								// has no local login. An admin password reset creates
								// one if local login is ever wanted.
								return created.id;
							});
							for (const server of decision.servers) {
								await mediaServerLinkService.linkValidatedServerUser(
									userId,
									server.serverId,
									account.id,
									server.serverUsername
								);
							}
							logger.info(
								{ userId, plexAccountId: account.id },
								'[PlexSignIn] Created account for new Plex user'
							);
							break;
						}
						case 'no-access':
							throw refuse(
								'FORBIDDEN',
								PLEX_SIGN_IN_ERROR_CODES.noAccess,
								'This Plex account does not have access to the Plex server.'
							);
						case 'not-linked':
							throw refuse(
								'FORBIDDEN',
								PLEX_SIGN_IN_ERROR_CODES.notLinked,
								'This Plex account is not linked to a Cinephage account.'
							);
						case 'account-unavailable':
							throw refuse(
								'CONFLICT',
								PLEX_SIGN_IN_ERROR_CODES.accountUnavailable,
								'An account could not be created for this Plex user.'
							);
						case 'ambiguous':
							throw refuse(
								'CONFLICT',
								PLEX_SIGN_IN_ERROR_CODES.ambiguous,
								'This Plex account is linked to more than one Cinephage account.'
							);
						case 'server-error':
							throw refuse(
								'BAD_GATEWAY',
								PLEX_SIGN_IN_ERROR_CODES.upstream,
								'Could not reach Plex.'
							);
					}

					const user = await ctx.context.internalAdapter.findUserById(userId);
					if (!user) {
						throw refuse(
							'FORBIDDEN',
							PLEX_SIGN_IN_ERROR_CODES.notLinked,
							'This Plex account is not linked to a Cinephage account.'
						);
					}

					// The admin plugin's session.create.before hook refuses
					// banned accounts here, same as password sign-in.
					const dontRememberMe = ctx.body.rememberMe !== true;
					const session = await ctx.context.internalAdapter.createSession(user.id, dontRememberMe);
					await setSessionCookie(ctx, { session, user }, dontRememberMe);

					logger.info({ userId: user.id, plexAccountId: account.id }, '[PlexSignIn] Signed in');
					return ctx.json({ status: 'signed-in' });
				}
			)
		},
		rateLimit: [
			// Each attempt creates one PIN; polling needs a far looser bucket
			// (one request every ~2s for up to the PIN's lifetime).
			{ pathMatcher: (path: string) => path === '/plex/pin', window: 900, max: 15 },
			{ pathMatcher: (path: string) => path === '/plex/sign-in', window: 600, max: 600 }
		]
	}) satisfies BetterAuthPlugin;
