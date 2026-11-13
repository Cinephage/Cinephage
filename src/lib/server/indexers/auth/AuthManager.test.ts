import { describe, expect, it } from 'vitest';
import { AuthManager } from './AuthManager.js';

type LoginDefinition = {
	id?: string;
	links?: string[];
	login?: { path?: string; test?: { selector?: string } };
};

function managerFor(login: LoginDefinition['login'], links: string[] = ['https://rutracker.org/']) {
	return new AuthManager(
		{ id: 'rutracker', links, login } as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);
}

/** A response that came out of a redirect chain, for the host-check tests. */
function redirectedTo(url: string): Response {
	return {
		ok: true,
		status: 200,
		redirected: true,
		url,
		headers: new Headers({ 'content-type': 'text/html' })
	} as unknown as Response;
}

const CHALLENGE_BODY =
	'<html><head><title>Just a moment...</title></head><body>cf_chl_opt Ray ID: 8f2a</body></html>';

describe('AuthManager.checkLoginNeeded', () => {
	it('treats a Cloudflare challenge as a block, not an expired session', () => {
		const manager = managerFor({ path: '/forum/login.php', test: { selector: 'a[href*=logout]' } });
		const response = new Response(CHALLENGE_BODY, {
			status: 403,
			headers: { 'content-type': 'text/html', server: 'cloudflare' }
		});

		expect(manager.checkLoginNeeded(response, CHALLENGE_BODY)).toBe(false);
	});

	it('still reports a plain 403 as a login problem', () => {
		const manager = managerFor({ path: '/forum/login.php' });
		const body = '<html><body>Forbidden</body></html>';
		const response = new Response(body, {
			status: 403,
			headers: { 'content-type': 'text/html' }
		});

		expect(manager.checkLoginNeeded(response, body)).toBe(true);
	});

	it('reports a missing login marker on a 200 page', () => {
		const manager = managerFor({ path: '/forum/login.php', test: { selector: 'a[href*=logout]' } });
		const body = '<html><body><a href="/forum/login.php">Вход</a></body></html>';
		const response = new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});

		expect(manager.checkLoginNeeded(response, body)).toBe(true);
	});

	it('accepts a 200 page that carries the login marker', () => {
		const manager = managerFor({ path: '/forum/login.php', test: { selector: 'a[href*=logout]' } });
		const body = '<html><body><a href="/forum/login.php?logout=1">Выход</a></body></html>';
		const response = new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});

		expect(manager.checkLoginNeeded(response, body)).toBe(false);
	});

	it('treats a hop to another listed mirror as a live session', () => {
		const manager = managerFor(
			{ path: '/forum/login.php', test: { selector: 'a[href*=logout]' } },
			['https://rutracker.org/', 'https://rutracker.net/', 'https://rutracker.nl/']
		);
		const body = '<html><body><a href="/forum/login.php?logout=1">Выход</a></body></html>';

		// Configured on .nl, answered from .org: a mirror hop, not a logout. The old
		// check compared against links[0] and forced a re-login here.
		expect(
			manager.checkLoginNeeded(
				redirectedTo('https://rutracker.org/forum/index.php'),
				body,
				'https://rutracker.nl/'
			)
		).toBe(false);
	});

	it('treats a hop to an unrelated host as a login problem', () => {
		const manager = managerFor({ path: '/forum/login.php', test: { selector: 'a[href*=logout]' } });
		const body = '<html><body><a href="/forum/login.php?logout=1">Выход</a></body></html>';

		expect(
			manager.checkLoginNeeded(
				redirectedTo('https://portal.example.net/login'),
				body,
				'https://rutracker.org/'
			)
		).toBe(true);
	});
});

describe('AuthManager.login', () => {
	const stubs = {
		templateEngine: {
			setSiteLink() {},
			setConfig() {}
		},
		filterEngine: {},
		selectorEngine: {},
		cookieStore: { load: async () => null, save: async () => {}, clear: async () => {} }
	};

	function authManager(login: unknown) {
		return new AuthManager(
			{ id: 'rutracker', links: ['https://rutracker.org/'], login } as never,
			stubs.templateEngine as never,
			stubs.filterEngine as never,
			stubs.selectorEngine as never,
			stubs.cookieStore as never
		);
	}

	it('uses a supplied session cookie instead of the declared login method', async () => {
		// RuTracker's login POST is the page Cloudflare challenges hardest; a cookie
		// from a real browser on this connection is the way around it. No fetch may
		// happen here.
		const manager = authManager({
			path: '/forum/login.php',
			method: 'post',
			inputs: { login_username: '{{ .Config.username }}' }
		});

		const result = await manager.login({
			indexerId: 'rutracker',
			baseUrl: 'https://rutracker.org/',
			settings: { cookie: 'bb_data=abc123; bb_guid=def456' }
		});

		expect(result.success).toBe(true);
		expect(result.cookies).toEqual({ bb_data: 'abc123', bb_guid: 'def456' });
	});

	it('falls through to the declared method when the cookie is blank', async () => {
		const manager = authManager({ path: '/forum/login.php', method: 'none' });

		const result = await manager.login({
			indexerId: 'rutracker',
			baseUrl: 'https://rutracker.org/',
			settings: { cookie: '   ' }
		});

		expect(result.success).toBe(true);
		expect(result.cookies).toEqual({});
	});
});
