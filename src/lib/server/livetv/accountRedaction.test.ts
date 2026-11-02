import { describe, expect, it } from 'vitest';
import { redactAccountSecrets } from './accountRedaction';
import { recordToAccount } from './LiveTvAccountManager';
import type { LivetvAccountRecord } from '#lib/server/db/schema.js';

function baseRecord(overrides: Partial<LivetvAccountRecord> = {}): LivetvAccountRecord {
	return {
		id: 'acct-1',
		name: 'Test',
		providerType: 'xstream',
		enabled: true,
		stalkerConfig: null,
		xstreamConfig: {
			baseUrl: 'http://portal.example',
			username: 'user1',
			password: 'supersecret',
			authToken: 'tok123'
		},
		m3uConfig: null,
		iptvOrgConfig: null,
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
		syncStatus: null,
		lastEpgSyncAt: null,
		lastEpgSyncError: null,
		epgProgramCount: null,
		hasEpg: null,
		createdAt: null,
		updatedAt: null,
		...overrides
	} as LivetvAccountRecord;
}

describe('redactAccountSecrets', () => {
	it('redacts xstream password and auth token but keeps the username', () => {
		const redacted = redactAccountSecrets(recordToAccount(baseRecord()));

		expect(redacted.xstreamConfig?.username).toBe('user1');
		expect(redacted.xstreamConfig?.password).toBe('[REDACTED]');
		expect(redacted.xstreamConfig?.authToken).toBe('[REDACTED]');
	});

	it('redacts stalker token and password', () => {
		const redacted = redactAccountSecrets(
			recordToAccount(
				baseRecord({
					providerType: 'stalker',
					xstreamConfig: null,
					stalkerConfig: {
						portalUrl: 'http://portal.example/stalker_portal',
						macAddress: '00:1A:79:AA:BB:CC',
						token: 'stalker-token',
						username: 'u',
						password: 'p'
					}
				})
			)
		);

		expect(redacted.stalkerConfig?.token).toBe('[REDACTED]');
		expect(redacted.stalkerConfig?.password).toBe('[REDACTED]');
	});

	it('leaves empty secrets undefined instead of redacting blanks', () => {
		const redacted = redactAccountSecrets(
			recordToAccount(
				baseRecord({
					xstreamConfig: {
						baseUrl: 'http://portal.example',
						username: 'user1',
						password: ''
					}
				})
			)
		);

		expect(redacted.xstreamConfig?.password).toBe('');
	});

	it('does not mutate the input account', () => {
		const account = recordToAccount(baseRecord());
		redactAccountSecrets(account);

		expect(account.xstreamConfig?.password).toBe('supersecret');
	});
});
