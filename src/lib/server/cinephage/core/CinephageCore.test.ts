import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CinephageSettingsService } from '../settings/CinephageSettingsService.js';

function createMockSettings(
	overrides: Partial<{
		enabled: boolean;
		baseUrl: string;
		versionOverride: string | null;
		commitOverride: string | null;
		autoUpdate: boolean;
		latestVersion: string | null;
		latestCommit: string | null;
		apiKey: string | null;
	}> = {}
): CinephageSettingsService {
	const state = {
		enabled: overrides.enabled ?? true,
		baseUrl: overrides.baseUrl ?? 'https://api.cinephage.net',
		versionOverride: overrides.versionOverride ?? null,
		commitOverride: overrides.commitOverride ?? null,
		autoUpdate: overrides.autoUpdate ?? true,
		latestVersion: overrides.latestVersion ?? null,
		latestCommit: overrides.latestCommit ?? null
	};
	return {
		getConfig: vi.fn(async () => ({ ...state })),
		updateConfig: vi.fn(async (updates: Record<string, unknown>) => {
			Object.assign(state, updates);
		}),
		getInstallApiKey: vi.fn(async () => overrides.apiKey ?? null),
		getOrCreateInstallId: vi.fn(async () => '11111111-2222-3333-4444-555555555555'),
		storeInstallApiKey: vi.fn(),
		clearInstallApiKey: vi.fn(),
		getModuleConfig: vi.fn(),
		setModuleEnabled: vi.fn(),
		updateModuleSettings: vi.fn(),
		recordModuleError: vi.fn(),
		clearModuleError: vi.fn()
	} as unknown as CinephageSettingsService;
}

afterEach(() => {
	delete process.env.APP_VERSION;
	delete process.env.APP_COMMIT;
});

describe('CinephageCore', () => {
	describe('getBaseUrl', () => {
		it('returns the configured base URL', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings({ baseUrl: 'https://custom.example.com' }));
			expect(await core.getBaseUrl()).toBe('https://custom.example.com');
		});

		it('returns the default base URL when not overridden', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			expect(await core.getBaseUrl()).toBe('https://api.cinephage.net');
		});
	});

	describe('isEnabled', () => {
		it('reflects enabled=true from settings', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings({ enabled: true }));
			expect(await core.isEnabled()).toBe(true);
		});

		it('reflects enabled=false from settings', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings({ enabled: false }));
			expect(await core.isEnabled()).toBe(false);
		});
	});

	describe('getIdentity', () => {
		it('returns identity resolved from settings overrides and env', async () => {
			process.env.APP_VERSION = '2.0.0';
			process.env.APP_COMMIT = 'feedface';
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const identity = await core.getIdentity();
			expect(identity.version).toBe('2.0.0');
			expect(identity.commit).toBe('feedface');
			expect(identity.isConfigured).toBe(true);
		});

		it('uses overrides when set', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(
				createMockSettings({ versionOverride: '9.9.9', commitOverride: 'override' })
			);
			const identity = await core.getIdentity();
			expect(identity.version).toBe('9.9.9');
			expect(identity.commit).toBe('override');
			expect(identity.isConfigured).toBe(true);
		});

		it('uses the auto-synced latest release before env vars', async () => {
			process.env.APP_VERSION = '2.0.0';
			process.env.APP_COMMIT = 'feedface';
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(
				createMockSettings({ latestVersion: '0.15.0', latestCommit: '8167446' })
			);
			const identity = await core.getIdentity();
			expect(identity.version).toBe('0.15.0');
			expect(identity.commit).toBe('8167446');
			expect(identity.isConfigured).toBe(true);
		});

		it('manual overrides win over the auto-synced latest', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(
				createMockSettings({
					versionOverride: '1.2.3',
					commitOverride: 'manual',
					latestVersion: '0.15.0',
					latestCommit: '8167446'
				})
			);
			const identity = await core.getIdentity();
			expect(identity.version).toBe('1.2.3');
			expect(identity.commit).toBe('manual');
		});

		it('ignores the auto-synced latest when autoUpdate is disabled', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(
				createMockSettings({
					autoUpdate: false,
					latestVersion: '0.15.0',
					latestCommit: '8167446'
				})
			);
			const identity = await core.getIdentity();
			expect(identity.version).not.toBe('0.15.0');
			expect(identity.commit).toBeNull();
			expect(identity.isConfigured).toBe(false);
		});

		it('reports not configured when commit cannot be resolved', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const identity = await core.getIdentity();
			expect(identity.commit).toBeNull();
			expect(identity.isConfigured).toBe(false);
		});
	});

	describe('refreshLatestIdentity', () => {
		it('fetches the latest release and persists the normalized identity', async () => {
			const fetchMock = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ tag_name: 'v0.15.0' }), { status: 200 })
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ sha: '8167446215701df8ece2b54e27c34be14b0094d7' }), {
						status: 200
					})
				);

			const settings = createMockSettings();
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings, { githubApiBase: 'https://gh.example.com' });
			await core.refreshLatestIdentity();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[0][0]).toBe(
				'https://gh.example.com/repos/Cinephage/Cinephage/releases/latest'
			);
			expect(fetchMock.mock.calls[1][0]).toBe(
				'https://gh.example.com/repos/Cinephage/Cinephage/commits/v0.15.0'
			);
			expect(settings.updateConfig).toHaveBeenCalledWith({
				latestVersion: 'v0.15.0',
				latestCommit: '8167446'
			});
			fetchMock.mockRestore();
		});

		it('respects the TTL for non-forced refreshes', async () => {
			const fetchMock = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ tag_name: 'v0.15.0' }), { status: 200 })
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ sha: '8167446215701df8ece2b54e27c34be14b0094d7' }), {
						status: 200
					})
				);

			const settings = createMockSettings();
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings, { githubApiBase: 'https://gh.example.com' });
			await core.refreshLatestIdentity();
			expect(fetchMock).toHaveBeenCalledTimes(2);

			// Second non-forced refresh within the TTL must not hit GitHub again.
			await core.refreshLatestIdentity();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			fetchMock.mockRestore();
		});

		it('forced refresh bypasses the TTL but respects the minimum interval', async () => {
			const fetchMock = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ tag_name: 'v0.15.0' }), { status: 200 })
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ sha: '8167446215701df8ece2b54e27c34be14b0094d7' }), {
						status: 200
					})
				);

			const settings = createMockSettings();
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings, { githubApiBase: 'https://gh.example.com' });
			await core.refreshLatestIdentity();
			expect(fetchMock).toHaveBeenCalledTimes(2);

			// Forced refresh right after is throttled by the min interval.
			await core.refreshLatestIdentity(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			fetchMock.mockRestore();
		});

		it('keeps the last known identity when GitHub is unreachable', async () => {
			const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

			const settings = createMockSettings({
				latestVersion: '0.14.2',
				latestCommit: '9bb5561'
			});
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings, { githubApiBase: 'https://gh.example.com' });
			await core.refreshLatestIdentity();

			expect(settings.updateConfig).not.toHaveBeenCalled();
			const identity = await core.getIdentity();
			expect(identity.version).toBe('0.14.2');
			expect(identity.commit).toBe('9bb5561');
			fetchMock.mockRestore();
		});

		it('skips the sync when autoUpdate is disabled', async () => {
			const fetchMock = vi.spyOn(globalThis, 'fetch');
			const settings = createMockSettings({ autoUpdate: false });
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings, { githubApiBase: 'https://gh.example.com' });
			await core.refreshLatestIdentity(true);
			expect(fetchMock).not.toHaveBeenCalled();
			fetchMock.mockRestore();
		});
	});

	describe('toggleVersionFormat', () => {
		it('strips the v prefix from a v-prefixed version', async () => {
			const settings = createMockSettings({ latestVersion: 'v0.15.0', latestCommit: '8167446' });
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);
			const identity = await core.toggleVersionFormat();
			expect(settings.updateConfig).toHaveBeenCalledWith({ latestVersion: '0.15.0' });
			expect(identity?.version).toBe('0.15.0');
		});

		it('adds the v prefix to a bare version', async () => {
			const settings = createMockSettings({ latestVersion: '0.15.0', latestCommit: '8167446' });
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);
			const identity = await core.toggleVersionFormat();
			expect(settings.updateConfig).toHaveBeenCalledWith({ latestVersion: 'v0.15.0' });
			expect(identity?.version).toBe('v0.15.0');
		});

		it('returns null when there is no auto-synced version', async () => {
			const settings = createMockSettings({ latestVersion: null, latestCommit: null });
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);
			const identity = await core.toggleVersionFormat();
			expect(identity).toBeNull();
			expect(settings.updateConfig).not.toHaveBeenCalled();
		});
	});

	describe('getAuthHeaders', () => {
		it('returns X-Cinephage-* headers when identity is configured', async () => {
			process.env.APP_VERSION = '2.0.0';
			process.env.APP_COMMIT = 'feedface';
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const headers = await core.getAuthHeaders();
			expect(headers['X-Cinephage-Version']).toBe('2.0.0');
			expect(headers['X-Cinephage-Commit']).toBe('feedface');
			delete process.env.APP_VERSION;
			delete process.env.APP_COMMIT;
		});

		it('returns empty headers when commit is missing', async () => {
			delete process.env.APP_COMMIT;
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const headers = await core.getAuthHeaders();
			expect(headers).toEqual({});
		});

		it('attaches X-API-Key when an install key is registered', async () => {
			process.env.APP_VERSION = '2.0.0';
			process.env.APP_COMMIT = 'feedface';
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings({ apiKey: 'ck_testkey1234567890' }));
			const headers = await core.getAuthHeaders();
			expect(headers['X-API-Key']).toBe('ck_testkey1234567890');
			expect(headers['X-Cinephage-Version']).toBe('2.0.0');
		});

		it('attaches X-API-Key even when identity is unresolved', async () => {
			delete process.env.APP_COMMIT;
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings({ apiKey: 'ck_testkey1234567890' }));
			const headers = await core.getAuthHeaders();
			expect(headers['X-API-Key']).toBe('ck_testkey1234567890');
			expect(headers['X-Cinephage-Version']).toBeUndefined();
		});
	});

	describe('install key registration', () => {
		const REGISTER_URL = 'https://api.cinephage.net/api/v1/auth/register';
		const REVOKE_URL = 'https://api.cinephage.net/api/v1/auth/revoke';

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('registers, stores the key encrypted, and returns it once', async () => {
			const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(
					JSON.stringify({
						key: 'ck_newkey00000000000000000000000',
						key_prefix: 'ck_newke',
						rotated: false,
						install_id: '11111111-2222-3333-4444-555555555555'
					}),
					{ status: 201 }
				)
			);
			const settings = createMockSettings();
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);

			const result = await core.registerInstallKey('user@example.com');

			expect(fetchMock.mock.calls[0][0]).toBe(REGISTER_URL);
			const init = fetchMock.mock.calls[0][1] as RequestInit;
			const body = JSON.parse(init.body as string) as Record<string, string>;
			expect(body.installId).toBe('11111111-2222-3333-4444-555555555555');
			expect(body.email).toBe('user@example.com');
			expect(result.key).toBe('ck_newkey00000000000000000000000');
			expect(result.rotated).toBe(false);
			expect(settings.storeInstallApiKey).toHaveBeenCalledWith(
				'ck_newkey00000000000000000000000',
				'ck_newke',
				'user@example.com'
			);
		});

		it('surfaces rate limiting as a typed error, never retrying', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response('{"error":{}}', { status: 429 })
			);
			const { CinephageCore, CinephageRegistrationError } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());

			await expect(core.registerInstallKey('user@example.com')).rejects.toMatchObject({
				code: 'rate_limited'
			});
			expect(() => {
				throw new CinephageRegistrationError('rate_limited', 'x');
			}).toThrow();
		});

		it.each(['install_blocked', 'email_blocked', 'install_limit'])(
			'maps a 403 denial code (%s) to a typed error with a generic message',
			async (denialCode) => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValue(
					new Response(
						JSON.stringify({
							error: {
								message: 'GATEWAY_PRIVATE_DENIAL_DETAIL',
								details: { code: denialCode }
							}
						}),
						{ status: 403 }
					)
				);
				const { CinephageCore } = await import('./CinephageCore.js');
				const core = new CinephageCore(createMockSettings());

				const rejection = await core.registerInstallKey('user@example.com').catch((e) => e);
				expect(rejection.code).toBe(denialCode);
				expect(rejection.message).not.toContain('GATEWAY_PRIVATE_DENIAL_DETAIL');
				expect(rejection.message).toBe('Registration is not available for this install');
			}
		);

		it('falls back to gateway_error for a 403 without a known denial code', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ error: { message: 'nope', details: { code: 'mystery' } } }), {
					status: 403
				})
			);
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());

			await expect(core.registerInstallKey('user@example.com')).rejects.toMatchObject({
				code: 'gateway_error'
			});
		});

		it('falls back to gateway_error for a 403 with an unparseable body', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 403 }));
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());

			await expect(core.registerInstallKey('user@example.com')).rejects.toMatchObject({
				code: 'gateway_error'
			});
		});

		it('rejects a 201 response that carries no key', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ ok: true }), { status: 201 })
			);
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			await expect(core.registerInstallKey('user@example.com')).rejects.toMatchObject({
				code: 'gateway_error'
			});
		});

		it('revokes via the stored key and clears local state', async () => {
			const fetchMock = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response(JSON.stringify({ revoked: true }), { status: 200 }));
			const settings = createMockSettings({ apiKey: 'ck_livekey0000000000000000000' });
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);

			const result = await core.revokeInstallKey();

			expect(fetchMock.mock.calls[0][0]).toBe(REVOKE_URL);
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
				key: string;
			};
			expect(body.key).toBe('ck_livekey0000000000000000000');
			expect(result).toEqual({ revoked: true, wasRegistered: true });
			expect(settings.clearInstallApiKey).toHaveBeenCalled();
		});

		it('revoke is a no-op when nothing is registered', async () => {
			const fetchMock = vi.spyOn(globalThis, 'fetch');
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());

			const result = await core.revokeInstallKey();

			expect(result).toEqual({ revoked: false, wasRegistered: false });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('revoke clears local state even when the gateway already forgot the key', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
			const settings = createMockSettings({ apiKey: 'ck_stale00000000000000000000' });
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);

			const result = await core.revokeInstallKey();
			expect(result.revoked).toBe(false);
			expect(settings.clearInstallApiKey).toHaveBeenCalled();
		});
	});

	describe('toGatewayErrorMessage', () => {
		it('points unregistered installs at registration on 401', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const message = await core.toGatewayErrorMessage(
				new Error('All URLs failed: https://x: HTTP 401: Unauthorized')
			);
			expect(message).toContain('register');
		});

		it('keeps the identity self-heal path for registered installs on 401', async () => {
			// autoUpdate disabled keeps the self-heal refresh from hitting GitHub.
			const settings = createMockSettings({
				apiKey: 'ck_livekey0000000000000000000',
				autoUpdate: false
			});
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(settings);
			const message = await core.toGatewayErrorMessage(new Error('HTTP 401: Unauthorized'));
			expect(message).toContain('rejected authentication');
		});

		it('maps 429 to a rate-limit message', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const message = await core.toGatewayErrorMessage(new Error('HTTP 429: Too Many Requests'));
			expect(message).toContain('rate limited');
		});

		it('passes through unrelated errors', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const message = await core.toGatewayErrorMessage(new Error('socket hang up'));
			expect(message).toBe('socket hang up');
		});
	});

	describe('singleton', () => {
		it('getCinephageCore returns the same instance until reset', async () => {
			const { getCinephageCore, resetCinephageCore } = await import('./CinephageCore.js');
			const a = getCinephageCore();
			const b = getCinephageCore();
			expect(a).toBe(b);
			resetCinephageCore();
		});

		it('resetCinephageCore forces a new instance', async () => {
			const { getCinephageCore, resetCinephageCore } = await import('./CinephageCore.js');
			const a = getCinephageCore();
			resetCinephageCore();
			const b = getCinephageCore();
			expect(a).not.toBe(b);
			resetCinephageCore();
		});
	});

	describe('getHttpClient', () => {
		it('returns the underlying IndexerHttp instance', async () => {
			const { CinephageCore } = await import('./CinephageCore.js');
			const core = new CinephageCore(createMockSettings());
			const client = core.getHttpClient();
			expect(client).toBeTruthy();
			expect(typeof client.get).toBe('function');
		});
	});
});
