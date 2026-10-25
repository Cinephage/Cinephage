import { describe, it, expect, vi } from 'vitest';
import { api, callHandler } from '../../../../test/api-helper.js';

vi.mock('#lib/server/auth/authorization.js', () => ({
	requireAdmin: vi.fn().mockReturnValue(null)
}));

const setExternalUrlMock = vi.fn().mockResolvedValue(undefined);

vi.mock('#lib/server/settings/SystemSettingsService.js', () => ({
	getSystemSettingsService: () => ({
		setExternalUrl: setExternalUrlMock,
		getExternalUrl: vi.fn().mockResolvedValue(null)
	})
}));

const { PUT } = await import('./+server.js');

describe('PUT /api/settings/external-url', () => {
	it('rejects a URL with a path component', async () => {
		// GitHub issue #596: a subpath silently 404s on every request once
		// saved — there's no base-path support anywhere in the app — so this
		// must be rejected up front with a clear reason, not accepted.
		const { status, data } = await callHandler<{ error?: string }>(PUT, 'PUT', {
			url: 'https://proxy.example.com/cinephage'
		});

		expect(status).toBe(400);
		expect(data.error).toMatch(/path/i);
		expect(setExternalUrlMock).not.toHaveBeenCalled();
	});

	it('rejects a URL with just a trailing slash path the same way', async () => {
		const { status } = await callHandler(PUT, 'PUT', {
			url: 'https://proxy.example.com/sub/'
		});

		expect(status).toBe(400);
		expect(setExternalUrlMock).not.toHaveBeenCalled();
	});

	it('accepts a bare domain with no path', async () => {
		const { status, data } = await api.put<{ success: boolean; url: string | null }>(PUT, {
			url: 'https://proxy.example.com'
		});

		expect(status).toBe(200);
		expect(data.success).toBe(true);
		expect(setExternalUrlMock).toHaveBeenCalledWith('https://proxy.example.com');
	});

	it('accepts a bare domain with only a trailing slash', async () => {
		setExternalUrlMock.mockClear();
		const { status } = await api.put(PUT, { url: 'https://proxy.example.com/' });

		expect(status).toBe(200);
		expect(setExternalUrlMock).toHaveBeenCalledWith('https://proxy.example.com/');
	});

	it('accepts clearing the external URL', async () => {
		setExternalUrlMock.mockClear();
		const { status, data } = await api.put<{ success: boolean; url: string | null }>(PUT, {
			url: ''
		});

		expect(status).toBe(200);
		expect(data.url).toBeNull();
		expect(setExternalUrlMock).toHaveBeenCalledWith(null);
	});
});
