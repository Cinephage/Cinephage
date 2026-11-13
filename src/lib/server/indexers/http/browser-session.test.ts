import { afterEach, describe, expect, it } from 'vitest';
import {
	clearSolvedSessions,
	getSolvedUserAgent,
	hostOf,
	rememberSolvedUserAgent
} from './browser-session.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0';

describe('browser-session', () => {
	afterEach(() => clearSolvedSessions());

	it('returns nothing for a host that was never solved', () => {
		expect(getSolvedUserAgent('rutracker.org')).toBeUndefined();
	});

	it('remembers the UA a solve used, per host', () => {
		rememberSolvedUserAgent('rutracker.org', UA);

		expect(getSolvedUserAgent('rutracker.org')).toBe(UA);
		expect(getSolvedUserAgent('rutracker.net')).toBeUndefined();
	});

	it('matches the host regardless of case or a www prefix', () => {
		rememberSolvedUserAgent('WWW.Rutracker.org', UA);

		expect(getSolvedUserAgent('rutracker.org')).toBe(UA);
	});

	it('expires a solve that is no longer fresh', () => {
		rememberSolvedUserAgent('rutracker.org', UA);

		expect(getSolvedUserAgent('rutracker.org', Date.now() + 31 * 60 * 1000)).toBeUndefined();
	});

	it('ignores an empty User-Agent', () => {
		rememberSolvedUserAgent('rutracker.org', '');

		expect(getSolvedUserAgent('rutracker.org')).toBeUndefined();
	});

	it('parses the host out of a URL and gives up on junk', () => {
		expect(hostOf('https://rutracker.org/forum/index.php')).toBe('rutracker.org');
		expect(hostOf('https://WWW.Example.COM/')).toBe('example.com');
		expect(hostOf('not a url')).toBeUndefined();
		expect(hostOf(undefined)).toBeUndefined();
	});
});
