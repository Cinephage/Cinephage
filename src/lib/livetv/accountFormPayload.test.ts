import { describe, expect, it } from 'vitest';
import { buildAccountRequestBody, buildAccountTestRequestBody } from './accountFormPayload';
import type { FormData, TestConfig } from '#lib/components/livetv/LiveTvAccountModal.svelte';

const baseFormData: FormData = {
	name: 'My Portal',
	providerType: 'stalker',
	epgUrl: '',
	autoRefresh: false,
	enabled: true
};

describe('buildAccountRequestBody stalker language', () => {
	it('includes the selected language in the create payload', () => {
		const body = buildAccountRequestBody(
			{
				...baseFormData,
				portalUrl: 'http://portal.example.com/c',
				macAddress: '00:1A:79:00:00:01',
				language: 'fr'
			},
			'add'
		);

		expect(body.providerType).toBe('stalker');
		expect(body.stalkerConfig).toEqual({
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1A:79:00:00:01',
			epgUrl: undefined,
			language: 'fr'
		});
	});

	it('includes the language in the edit payload as well', () => {
		const body = buildAccountRequestBody(
			{
				...baseFormData,
				portalUrl: 'http://portal.example.com/c',
				macAddress: '00:1A:79:00:00:01',
				language: 'de'
			},
			'edit'
		);

		expect(body.stalkerConfig).toEqual({
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1A:79:00:00:01',
			epgUrl: undefined,
			language: 'de'
		});
	});
});

describe('buildAccountTestRequestBody stalker language', () => {
	it('includes the language in the test payload', () => {
		const config: TestConfig = {
			providerType: 'stalker',
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1A:79:00:00:01',
			language: 'ru'
		};

		const body = buildAccountTestRequestBody(config);

		expect(body.stalkerConfig).toEqual({
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1A:79:00:00:01',
			language: 'ru'
		});
	});

	it('leaves non-stalker payloads untouched', () => {
		const body = buildAccountRequestBody(
			{
				...baseFormData,
				providerType: 'xstream',
				baseUrl: 'http://xstream.example.com',
				username: 'user',
				password: 'pass',
				language: 'fr'
			},
			'add'
		);

		expect(body.xstreamConfig).toEqual({
			baseUrl: 'http://xstream.example.com',
			username: 'user',
			password: 'pass',
			epgUrl: undefined
		});
		expect(body.stalkerConfig).toBeUndefined();
	});
});
