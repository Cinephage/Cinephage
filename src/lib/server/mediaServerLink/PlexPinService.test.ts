/**
 * PlexPinService: handles are opaque, bound to their purpose, and an
 * approved PIN's token is handed out exactly once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const plexTv = vi.hoisted(() => ({
	createPlexPin: vi.fn(),
	checkPlexPin: vi.fn(),
	buildPlexAuthUrl: vi.fn(async (code: string) => `https://app.plex.tv/auth#?code=${code}`)
}));

vi.mock('./plexTv.js', () => plexTv);

const { plexPinService } = await import('./PlexPinService.js');

beforeEach(() => {
	plexPinService.clear();
	plexTv.createPlexPin.mockReset().mockResolvedValue({ id: 77, code: 'abc' });
	plexTv.checkPlexPin.mockReset();
});

describe('PlexPinService', () => {
	it('returns an opaque handle and the approval URL', async () => {
		const pin = await plexPinService.create({ kind: 'sign-in' });
		expect(pin.authUrl).toBe('https://app.plex.tv/auth#?code=abc');
		expect(pin.handle).not.toContain('77');
		expect(pin.expiresAt).toBeGreaterThan(Date.now());
	});

	it('reports pending, then hands the token out exactly once', async () => {
		const { handle } = await plexPinService.create({ kind: 'sign-in' });

		plexTv.checkPlexPin.mockResolvedValueOnce('pending');
		expect(await plexPinService.poll(handle, { kind: 'sign-in' })).toEqual({ outcome: 'pending' });

		plexTv.checkPlexPin.mockResolvedValueOnce({ authToken: 'tok' });
		expect(await plexPinService.poll(handle, { kind: 'sign-in' })).toEqual({
			outcome: 'authorized',
			authToken: 'tok'
		});

		expect(await plexPinService.poll(handle, { kind: 'sign-in' })).toEqual({ outcome: 'expired' });
		expect(plexTv.checkPlexPin).toHaveBeenCalledTimes(2);
	});

	it('binds a handle to its purpose and account', async () => {
		const { handle } = await plexPinService.create({ kind: 'link', userId: 'user-a' });
		plexTv.checkPlexPin.mockResolvedValue({ authToken: 'tok' });

		expect(await plexPinService.poll(handle, { kind: 'sign-in' })).toEqual({ outcome: 'expired' });
		expect(await plexPinService.poll(handle, { kind: 'link', userId: 'user-b' })).toEqual({
			outcome: 'expired'
		});
		// Mismatched polls never reached plex.tv, and didn't burn the handle.
		expect(plexTv.checkPlexPin).not.toHaveBeenCalled();
		expect(await plexPinService.poll(handle, { kind: 'link', userId: 'user-a' })).toMatchObject({
			outcome: 'authorized'
		});
	});

	it('expires a handle plex.tv no longer knows', async () => {
		const { handle } = await plexPinService.create({ kind: 'sign-in' });
		plexTv.checkPlexPin.mockResolvedValueOnce(null);
		expect(await plexPinService.poll(handle, { kind: 'sign-in' })).toEqual({ outcome: 'expired' });
	});
});
