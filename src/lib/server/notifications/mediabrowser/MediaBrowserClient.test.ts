/**
 * MediaBrowserClient - product detection and shared auth headers.
 *
 * Connect/test must decide the server type from what the running server
 * reports (ProductName / Plex identity), never from a hardcoded assumption.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaBrowserClient } from './MediaBrowserClient';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function xmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
}

describe('MediaBrowserClient.detectServerType', () => {
	it('detects Jellyfin from the public system info ProductName', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					ServerName: 'Living Room',
					Version: '12.0.0',
					Id: 'abc',
					ProductName: 'Jellyfin Server'
				})
			)
		);

		const detected = await MediaBrowserClient.detectServerType('http://jellyfin.local:8096');

		expect(detected).toMatchObject({
			type: 'jellyfin',
			productName: 'Jellyfin Server',
			version: '12.0.0',
			serverName: 'Living Room',
			id: 'abc'
		});
	});

	it('detects Emby from the public system info ProductName', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					ServerName: 'Emby Box',
					Version: '4.8.0',
					Id: 'emby-id',
					ProductName: 'Emby Server'
				})
			)
		);

		const detected = await MediaBrowserClient.detectServerType('http://emby.local:8096');

		expect(detected).toMatchObject({ type: 'emby', productName: 'Emby Server' });
	});

	it('detects Plex from the identity endpoint when MediaBrowser probes fail', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('not found', { status: 404 }))
			.mockResolvedValueOnce(
				xmlResponse(
					'<?xml version="1.0"?><MediaContainer machineIdentifier="plex-machine" version="1.40.0" friendlyName="Plex Home"/>'
				)
			);
		vi.stubGlobal('fetch', fetchMock);

		const detected = await MediaBrowserClient.detectServerType('http://plex.local:32400');

		expect(detected).toMatchObject({
			type: 'plex',
			id: 'plex-machine',
			serverName: 'Plex Home',
			version: '1.40.0'
		});
	});

	it('returns null when nothing identifiable answers', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));

		expect(await MediaBrowserClient.detectServerType('http://example.test')).toBeNull();
	});

	it('does not infer a type from a version string', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					ServerName: 'Mystery',
					Version: '12.0.0',
					Id: 'x'
					// no ProductName: must not be guessed from Version
				})
			)
		);

		expect(await MediaBrowserClient.detectServerType('http://mystery.test')).toBeNull();
	});
});

describe('MediaBrowserClient.authHeadersFor', () => {
	it('uses the composite Authorization header for Jellyfin (12.x compatible)', () => {
		const headers = MediaBrowserClient.authHeadersFor('jellyfin', 'secret-key');

		expect(headers.Authorization).toContain('Client="Cinephage"');
		expect(headers.Authorization).toContain('Token="secret-key"');
		expect(headers['X-Emby-Token']).toBeUndefined();
	});

	it('uses the token header for Emby', () => {
		expect(MediaBrowserClient.authHeadersFor('emby', 'emby-key')).toEqual({
			'X-Emby-Token': 'emby-key'
		});
	});
});
