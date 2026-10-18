import { describe, it, expect } from 'vitest';
import {
	stripSecureFromSetCookie,
	stripSecureCookiesForLocalHttp,
	rewriteCookieHeaderForLocalHttp
} from './session-helpers.js';
import type { Handle } from '@sveltejs/kit/hooks';

type RequestEvent = Parameters<Handle>[0]['event'];

function makeEvent(url: string, headers: Record<string, string> = {}): RequestEvent {
	return {
		url: new URL(url),
		request: new Request(url, { headers })
	} as unknown as RequestEvent;
}

// The real cookie name better-auth builds for this app (cookiePrefix:
// 'cinephage') when useSecureCookies is true - see AUTH_COOKIE_PREFIX in
// auth.ts. Tests must exercise this exact name, not a made-up one: that's
// what let issue #615's bug (prefix surviving the Secure-attribute strip)
// pass review undetected.
const SECURED_SESSION_COOKIE = '__Secure-cinephage.session_token';
const PLAIN_SESSION_COOKIE = 'cinephage.session_token';

describe('stripSecureFromSetCookie', () => {
	it('removes Secure and the __Secure- name prefix together, leaves other attributes intact', () => {
		expect(
			stripSecureFromSetCookie(
				`${SECURED_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure; SameSite=Lax`
			)
		).toBe(`${PLAIN_SESSION_COOKIE}=abc; Path=/; HttpOnly; SameSite=Lax`);
		expect(stripSecureFromSetCookie('a=b; secure')).toBe('a=b');
		expect(stripSecureFromSetCookie('a=b; SECURE; Path=/')).toBe('a=b; Path=/');
	});

	it('removes the __Host- name prefix too', () => {
		expect(stripSecureFromSetCookie('__Host-cinephage.csrf=xyz; Path=/; Secure')).toBe(
			'cinephage.csrf=xyz; Path=/'
		);
	});

	it('no-ops on a cookie without Secure or a name prefix', () => {
		expect(stripSecureFromSetCookie('a=b; Path=/; HttpOnly')).toBe('a=b; Path=/; HttpOnly');
	});
});

describe('stripSecureCookiesForLocalHttp', () => {
	function responseWithCookie(cookie: string): Response {
		return new Response(null, { headers: { 'set-cookie': cookie } });
	}

	it('strips Secure and the name prefix for a direct LAN http request', async () => {
		const event = makeEvent('http://192.168.1.10:3000/api/auth/sign-in/username');
		const response = responseWithCookie(`${SECURED_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure`);

		const result = stripSecureCookiesForLocalHttp(event, response);

		expect(result.headers.getSetCookie()).toEqual([
			`${PLAIN_SESSION_COOKIE}=abc; Path=/; HttpOnly`
		]);
	});

	it('keeps Secure and the name prefix when X-Forwarded-Proto: https is present, even on a private-IP Host', () => {
		const event = makeEvent('http://192.168.1.10:3000/api/auth/sign-in/username', {
			'x-forwarded-proto': 'https'
		});
		const response = responseWithCookie(`${SECURED_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure`);

		const result = stripSecureCookiesForLocalHttp(event, response);

		expect(result.headers.getSetCookie()).toEqual([
			`${SECURED_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure`
		]);
	});

	it('keeps Secure and the name prefix for a public-domain (reverse-proxied) request', () => {
		const event = makeEvent('http://proxy.example.com/api/auth/sign-in/username');
		const response = responseWithCookie(`${SECURED_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure`);

		const result = stripSecureCookiesForLocalHttp(event, response);

		expect(result.headers.getSetCookie()).toEqual([
			`${SECURED_SESSION_COOKIE}=abc; Path=/; HttpOnly; Secure`
		]);
	});

	it('is a no-op when the response sets no cookies', () => {
		const event = makeEvent('http://192.168.1.10:3000/health');
		const response = new Response('ok');

		const result = stripSecureCookiesForLocalHttp(event, response);

		expect(result).toBe(response);
	});

	it('is a no-op when the response cookie already has no Secure attribute or name prefix', () => {
		const event = makeEvent('http://192.168.1.10:3000/api/auth/sign-in/username');
		const response = responseWithCookie(`${PLAIN_SESSION_COOKIE}=abc; Path=/; HttpOnly`);

		const result = stripSecureCookiesForLocalHttp(event, response);

		expect(result).toBe(response);
	});
});

describe('rewriteCookieHeaderForLocalHttp', () => {
	it('adds the __Secure--prefixed name alongside a plain-named cookie on a direct LAN http request', () => {
		const event = makeEvent('http://192.168.1.10:3000/api/library');
		const headers = new Headers({ cookie: `${PLAIN_SESSION_COOKIE}=abc; cinephage-theme=dark` });

		const result = rewriteCookieHeaderForLocalHttp(event, headers);

		expect(result.get('cookie')).toBe(
			`${PLAIN_SESSION_COOKIE}=abc; cinephage-theme=dark; ${SECURED_SESSION_COOKIE}=abc`
		);
	});

	it('does not duplicate a cookie that already has the secured name present', () => {
		const event = makeEvent('http://192.168.1.10:3000/api/library');
		const headers = new Headers({
			cookie: `${PLAIN_SESSION_COOKIE}=abc; ${SECURED_SESSION_COOKIE}=abc`
		});

		const result = rewriteCookieHeaderForLocalHttp(event, headers);

		expect(result.get('cookie')).toBe(`${PLAIN_SESSION_COOKIE}=abc; ${SECURED_SESSION_COOKIE}=abc`);
	});

	it('leaves the header untouched for a reverse-proxied (non-LAN) request', () => {
		const event = makeEvent('http://proxy.example.com/api/library');
		const headers = new Headers({ cookie: `${PLAIN_SESSION_COOKIE}=abc` });

		const result = rewriteCookieHeaderForLocalHttp(event, headers);

		expect(result).toBe(headers);
	});

	it('leaves the header untouched for a LAN request behind a TLS-terminating proxy', () => {
		const event = makeEvent('http://192.168.1.10:3000/api/library', {
			'x-forwarded-proto': 'https'
		});
		const headers = new Headers({ cookie: `${PLAIN_SESSION_COOKIE}=abc` });

		const result = rewriteCookieHeaderForLocalHttp(event, headers);

		expect(result).toBe(headers);
	});

	it('is a no-op when there is no cookie header', () => {
		const event = makeEvent('http://192.168.1.10:3000/api/library');
		const headers = new Headers();

		const result = rewriteCookieHeaderForLocalHttp(event, headers);

		expect(result).toBe(headers);
	});
});
