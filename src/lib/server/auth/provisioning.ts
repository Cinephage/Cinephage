/**
 * Trusted account provisioning marker.
 *
 * Public self-registration is closed: the user.create.before hook refuses
 * any account creation that isn't backed by an admin session. Plex sign-in
 * with "create accounts for new Plex users" enabled is the one sanctioned
 * exception - the admin opted in, and the caller has just proven, via
 * plex.tv, access to the admin's own Plex server. That code path runs its
 * creation inside runTrustedProvisioning so the hook can tell it apart from
 * a raw sign-up request. The marker lives in AsyncLocalStorage, never in
 * request input, so no client can set it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type ProvisioningSource = 'plex';

const storage = new AsyncLocalStorage<{ source: ProvisioningSource }>();

export function runTrustedProvisioning<T>(
	source: ProvisioningSource,
	fn: () => Promise<T>
): Promise<T> {
	return storage.run({ source }, fn);
}

export function getTrustedProvisioningSource(): ProvisioningSource | null {
	return storage.getStore()?.source ?? null;
}
