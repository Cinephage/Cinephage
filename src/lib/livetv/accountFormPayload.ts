/**
 * Live TV account form payload builders.
 *
 * Extracted from the accounts page (`src/routes/livetv/accounts/+page.svelte`)
 * so the request shapes stay unit-testable outside the route component.
 */
import type { FormData, TestConfig } from '#lib/components/livetv/LiveTvAccountModal.svelte';

/**
 * Build the request body for creating (mode 'add') or updating (mode 'edit')
 * an account from the modal's form output.
 */
export function buildAccountRequestBody(
	data: FormData,
	mode: 'add' | 'edit'
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		name: data.name,
		providerType: data.providerType,
		testFirst: false,
		enabled: data.enabled
	};

	switch (data.providerType) {
		case 'stalker':
			body.stalkerConfig = {
				portalUrl: data.portalUrl,
				macAddress: data.macAddress,
				epgUrl: data.epgUrl || undefined,
				language: data.language
			};
			break;
		case 'xstream': {
			const normalizedXstreamEpgUrl = data.epgUrl.trim();
			body.xstreamConfig = {
				baseUrl: data.baseUrl,
				username: data.username,
				password: data.password,
				// In edit mode, send empty string to explicitly clear an existing EPG URL.
				epgUrl: normalizedXstreamEpgUrl || (mode === 'edit' ? '' : undefined)
			};
			break;
		}
		case 'm3u':
			{
				const normalizedEpgUrl = data.epgUrl.trim();
				body.m3uConfig = {
					url: data.url || undefined,
					fileContent: data.fileContent || undefined,
					// In edit mode, send empty string to explicitly clear an existing EPG URL.
					epgUrl: normalizedEpgUrl || (mode === 'edit' ? '' : undefined),
					autoRefresh: data.autoRefresh
				};
			}
			break;
		case 'cinephage-iptv':
			if (data.cinephageIptvConfig) {
				body.cinephageIptvConfig = data.cinephageIptvConfig;
			}
			break;
	}

	return body;
}

/**
 * Build the request body for testing an account configuration without saving.
 */
export function buildAccountTestRequestBody(config: TestConfig): Record<string, unknown> {
	const body: Record<string, unknown> = {
		providerType: config.providerType
	};

	if (config.accountId) {
		body.accountId = config.accountId;
	}

	switch (config.providerType) {
		case 'stalker':
			body.stalkerConfig = {
				portalUrl: config.portalUrl,
				macAddress: config.macAddress,
				language: config.language
			};
			break;
		case 'xstream':
			body.xstreamConfig = {
				baseUrl: config.baseUrl,
				username: config.username,
				password: config.password,
				epgUrl: config.epgUrl
			};
			break;
		case 'm3u':
			body.m3uConfig = {
				url: config.url,
				fileContent: config.fileContent,
				epgUrl: config.epgUrl
			};
			break;
		case 'cinephage-iptv':
			if (config.cinephageIptvConfig) {
				body.cinephageIptvConfig = config.cinephageIptvConfig;
			}
			break;
	}

	return body;
}
