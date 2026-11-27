/**
 * Pending Plex PIN sign-ins, held server-side.
 *
 * The browser only ever receives an opaque random handle plus the Plex
 * approval URL. The plex.tv PIN id and the resulting auth token stay in
 * this process, so whoever holds the handle (the tab that started the
 * flow) is the only party that can complete it - and only for the purpose
 * it was created for (signing in, or linking one specific account).
 */

import { randomBytes } from 'node:crypto';
import { buildPlexAuthUrl, checkPlexPin, createPlexPin } from './plexTv.js';

/** plex.tv PINs live ~15 minutes; give up a little sooner. */
const PIN_TTL_MS = 10 * 60 * 1000;
/** Unauthenticated callers can create PINs; bound the memory they can pin. */
const MAX_PENDING = 500;

export type PlexPinPurpose = { kind: 'sign-in' } | { kind: 'link'; userId: string };

type PendingPin = {
	pinId: number;
	purpose: PlexPinPurpose;
	expiresAt: number;
};

export type PlexPinPollResult =
	{ outcome: 'pending' } | { outcome: 'expired' } | { outcome: 'authorized'; authToken: string };

function samePurpose(a: PlexPinPurpose, b: PlexPinPurpose): boolean {
	if (a.kind !== b.kind) return false;
	return a.kind === 'sign-in' || a.userId === (b as { userId: string }).userId;
}

class PlexPinService {
	private readonly pending = new Map<string, PendingPin>();

	private prune(now = Date.now()): void {
		for (const [handle, pin] of this.pending) {
			if (pin.expiresAt <= now) this.pending.delete(handle);
		}
		// Still full of live entries: drop the oldest (insertion order).
		while (this.pending.size >= MAX_PENDING) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.pending.delete(oldest);
		}
	}

	async create(
		purpose: PlexPinPurpose
	): Promise<{ handle: string; authUrl: string; expiresAt: number }> {
		const pin = await createPlexPin();
		this.prune();
		const handle = randomBytes(32).toString('base64url');
		const expiresAt = Date.now() + PIN_TTL_MS;
		this.pending.set(handle, { pinId: pin.id, purpose, expiresAt });
		return { handle, authUrl: await buildPlexAuthUrl(pin.code), expiresAt };
	}

	/**
	 * Poll a pending PIN. An authorized PIN is consumed: the token is handed
	 * out exactly once and the handle stops working.
	 */
	async poll(handle: string, purpose: PlexPinPurpose): Promise<PlexPinPollResult> {
		const pin = this.pending.get(handle);
		if (!pin || !samePurpose(pin.purpose, purpose)) {
			return { outcome: 'expired' };
		}
		if (pin.expiresAt <= Date.now()) {
			this.pending.delete(handle);
			return { outcome: 'expired' };
		}

		const status = await checkPlexPin(pin.pinId);
		if (status === null) {
			this.pending.delete(handle);
			return { outcome: 'expired' };
		}
		if (status === 'pending') {
			return { outcome: 'pending' };
		}
		this.pending.delete(handle);
		return { outcome: 'authorized', authToken: status.authToken };
	}

	cancel(handle: string): void {
		this.pending.delete(handle);
	}

	/** Test seam. */
	clear(): void {
		this.pending.clear();
	}
}

export const plexPinService = new PlexPinService();
