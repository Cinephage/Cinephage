import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns', () => ({
	promises: { lookup: dnsLookupMock }
}));

import { fetchWithTimeout, isPrivateIp, resolveAndValidateUrl } from './ssrf-protection';

describe('fetchWithTimeout signal handling', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		dnsLookupMock.mockReset();
	});

	it('composes the supplied signal with the timeout signal', async () => {
		const external = new AbortController();
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, options: RequestInit) => {
				requestSignal = options.signal as AbortSignal;
				return new Promise<Response>((_resolve, reject) => {
					requestSignal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{
							once: true
						}
					);
				});
			})
		);

		// A literal public IP: fetchWithTimeout validates every URL, and a
		// hostname would need a DNS answer before the fetch even starts.
		const pending = fetchWithTimeout(
			'https://93.184.216.34/stream',
			{ signal: external.signal },
			10_000
		);
		// Let the async validation settle so the request is actually in flight
		// before aborting; otherwise the abort lands before fetch is called.
		await new Promise((resolve) => setTimeout(resolve, 0));
		external.abort();

		await expect(pending).rejects.toThrow('Aborted');
		expect(requestSignal?.aborted).toBe(true);
	});

	it('rejects an unsafe URL before issuing any request', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await expect(fetchWithTimeout('http://169.254.169.254/latest/meta-data', {})).rejects.toThrow(
			/Private\/internal IP address/
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('pins hostname fetches through undici fetch, not global fetch', async () => {
		// Regression: passing an npm-undici Agent to Node's global fetch mixes
		// two undici copies with incompatible Dispatcher contracts — every
		// proxied hostname fetch failed at connect with `invalid onRequestStart
		// method`. The Agent and the fetch must come from the same package.
		dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		const globalFetch = vi.fn();
		vi.stubGlobal('fetch', globalFetch);

		const undiciFetch = vi.fn(
			async (_url: string, _init?: Record<string, unknown>) => new Response('ok')
		);
		const agentInstances: Array<{ connect: unknown; closed: boolean }> = [];
		vi.doMock('undici', () => ({
			fetch: undiciFetch,
			Agent: class {
				connect: unknown;
				closed = false;
				constructor(options: { connect: unknown }) {
					this.connect = options.connect;
					agentInstances.push(this);
				}
				async close() {
					this.closed = true;
				}
			}
		}));

		try {
			vi.resetModules();
			const { fetchWithTimeout: fetchWithTimeoutFresh } = await import('./ssrf-protection');
			const response = await fetchWithTimeoutFresh('https://public.example/stream', {});

			expect(response.status).toBe(200);
			// Global fetch must be untouched for hostname fetches.
			expect(globalFetch).not.toHaveBeenCalled();
			expect(undiciFetch).toHaveBeenCalledTimes(1);
			expect(undiciFetch.mock.calls[0]?.[1]?.dispatcher).toBeDefined();

			// The pinned lookup returns exactly the validated address, and the
			// agent is released only once the body has been consumed, so sockets
			// do not accumulate but a streamed body is never cut off underneath
			// the caller (issue: closing right after the headers deadlocked
			// large proxied bodies - HLS segments - until the timeout abort).
			const agent = agentInstances[0];
			expect(agent).toBeDefined();
			const lookupResult = (await new Promise((resolve) => {
				(
					agent!.connect as {
						lookup: (
							host: string,
							opts: unknown,
							cb: (err: null, addresses: Array<{ address: string; family: number }>) => void
						) => void;
					}
				).lookup('public.example', {}, (err, addresses) => resolve({ err, addresses }));
			})) as { err: null; addresses: Array<{ address: string; family: number }> };
			expect(lookupResult.err).toBeNull();
			expect(lookupResult.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
			// Headers arrived but the body has not been read yet - the agent must
			// still be alive, or the connection under the body would be destroyed.
			expect(agent!.closed).toBe(false);

			// Consuming the body releases the agent.
			expect(await response.text()).toBe('ok');
			// Let the deferred close (fire-and-forget) run.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(agent!.closed).toBe(true);
		} finally {
			vi.doUnmock('undici');
			vi.resetModules();
		}
	});
});

describe('resolveAndValidateUrl DNS safety', () => {
	beforeEach(() => dnsLookupMock.mockReset());

	it('rejects a hostname when any DNS result is private', async () => {
		dnsLookupMock.mockResolvedValue([
			{ address: '93.184.216.34', family: 4 },
			{ address: '192.168.1.20', family: 4 }
		]);

		await expect(resolveAndValidateUrl('https://mixed.example/stream')).resolves.toMatchObject({
			safe: false,
			reason: expect.stringContaining('192.168.1.20')
		});
		expect(dnsLookupMock).toHaveBeenCalledWith('mixed.example', { all: true, verbatim: true });
	});

	it('preserves safe hostname and literal IP behavior', async () => {
		dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

		await expect(resolveAndValidateUrl('https://public.example/stream')).resolves.toEqual({
			safe: true
		});
		await expect(resolveAndValidateUrl('https://127.0.0.1/stream')).resolves.toMatchObject({
			safe: false
		});
		expect(dnsLookupMock).toHaveBeenCalledTimes(1);
	});

	it.each(['https://[::1]/stream', 'https://[::ffff:127.0.0.1]/stream'])(
		'rejects private bracketed IPv6 literal %s',
		async (url) => {
			await expect(resolveAndValidateUrl(url)).resolves.toMatchObject({
				safe: false,
				reason: 'Private/internal IP address'
			});
			expect(dnsLookupMock).not.toHaveBeenCalled();
		}
	);
});

/**
 * The old deny-list was a set of prefix regexes, which missed whole ranges:
 * `fc00:` only matched fc00 (not fc01-fcff), `fe80:` only fe80 (not
 * fe90-febf), and the NAT64/6to4/teredo forms were written with dotted
 * decimals that the URL parser never produces.
 */
describe('isPrivateIp range coverage', () => {
	it.each([
		['127.0.0.1', 'IPv4 loopback'],
		['10.1.2.3', 'RFC1918 10/8'],
		['172.16.0.1', 'RFC1918 172.16/12'],
		['172.31.255.254', 'RFC1918 172.16/12 upper'],
		['192.168.1.1', 'RFC1918 192.168/16'],
		['169.254.169.254', 'cloud metadata link-local'],
		['100.64.0.1', 'CGNAT'],
		['0.0.0.0', 'unspecified'],
		['198.18.0.1', 'benchmarking 198.18/15'],
		['198.19.255.254', 'benchmarking upper half'],
		['224.0.0.1', 'multicast'],
		['240.0.0.1', 'reserved'],
		['255.255.255.255', 'broadcast'],
		['192.88.99.1', '6to4 relay anycast'],
		['::1', 'IPv6 loopback'],
		['::', 'IPv6 unspecified'],
		['fc00::1', 'IPv6 unique-local fc00'],
		['fc01::1', 'IPv6 unique-local fc01 (old regex missed this)'],
		['fcff::1', 'IPv6 unique-local fcff (old regex missed this)'],
		['fd12:3456::1', 'IPv6 unique-local fd00/8'],
		['fe80::1', 'IPv6 link-local fe80'],
		['fe90::1', 'IPv6 link-local fe90 (old regex missed this)'],
		['febf::1', 'IPv6 link-local febf (old regex missed this)'],
		['fec0::1', 'IPv6 site-local'],
		['ff02::1', 'IPv6 multicast'],
		['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
		['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
		['::ffff:10.0.0.1', 'IPv4-mapped RFC1918'],
		['::ffff:0:127.0.0.1', 'IPv4-translated loopback'],
		['64:ff9b::7f00:1', 'NAT64 to loopback (hex form; old regex missed this)'],
		['64:ff9b::a9fe:a9fe', 'NAT64 to metadata (hex form; old regex missed this)'],
		['2002:7f00:1::', '6to4 to loopback'],
		['2002:a9fe:a9fe::', '6to4 to metadata'],
		['2001::1', 'Teredo'],
		['2001:db8::1', 'documentation prefix'],
		['100::1', 'discard prefix'],
		['not-an-ip', 'unparseable fails closed']
	])('blocks %s (%s)', (ip) => {
		expect(isPrivateIp(ip)).toBe(true);
	});

	it.each([
		['8.8.8.8', 'public DNS'],
		['1.1.1.1', 'public DNS'],
		['93.184.216.34', 'public web'],
		['2606:4700:4700::1111', 'public IPv6'],
		['2001:470::1', 'public 2001::/16 (not Teredo)']
	])('allows %s (%s)', (ip) => {
		expect(isPrivateIp(ip)).toBe(false);
	});
});

describe('resolveAndValidateUrl IPv6 literals', () => {
	beforeEach(() => dnsLookupMock.mockReset());

	it.each([
		'https://[fc01::1]/x',
		'https://[fe90::1]/x',
		'https://[64:ff9b::7f00:1]/x',
		'https://[2002:7f00:1::]/x',
		'https://[2001::1]/x'
	])('rejects %s without a DNS lookup', async (url) => {
		await expect(resolveAndValidateUrl(url)).resolves.toMatchObject({ safe: false });
		expect(dnsLookupMock).not.toHaveBeenCalled();
	});
});
