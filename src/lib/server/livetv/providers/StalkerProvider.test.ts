import { describe, expect, it, vi } from 'vitest';
import type { LiveTvAccount } from '#lib/types/livetv.js';

vi.mock('#lib/server/db/index.js', () => ({
	db: {},
	sqlite: {},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

import { StalkerProvider } from './StalkerProvider';

function createAccount(
	stalkerConfig: Partial<NonNullable<LiveTvAccount['stalkerConfig']>> = {}
): LiveTvAccount {
	return {
		id: 'stalker-account',
		name: 'My Portal',
		providerType: 'stalker',
		enabled: true,
		stalkerConfig: {
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1A:79:00:00:01',
			...stalkerConfig
		},
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
}

function buildClientConfig(provider: StalkerProvider, account: LiveTvAccount) {
	// @ts-expect-error accessing private method for testing
	return provider.buildClientConfig(account);
}

describe('StalkerProvider buildClientConfig language mapping', () => {
	it('threads the configured language through to the portal client config', () => {
		const config = buildClientConfig(new StalkerProvider(), createAccount({ language: 'ru' }));

		expect(config.language).toBe('ru');
	});

	it('defaults to English for old configs without a language field', () => {
		const config = buildClientConfig(new StalkerProvider(), createAccount());

		expect(config.language).toBe('en');
	});
});
