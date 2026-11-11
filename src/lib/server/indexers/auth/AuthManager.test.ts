import { describe, expect, it } from 'vitest';
import { AuthManager } from './AuthManager.js';

type LoginDefinition = {
	id?: string;
	links?: string[];
	login?: { path?: string; test?: { selector?: string } };
};

function managerFor(login: LoginDefinition['login']) {
	return new AuthManager(
		{ id: 'rutracker', links: ['https://rutracker.org/'], login } as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);
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
});
