/**
 * Browser half of the Plex PIN flow (sign-in and account linking).
 *
 * The server creates the PIN and hands back an opaque handle plus Plex's
 * approval URL; this opens that URL in a popup and polls the server with
 * the handle until the PIN resolves. The Plex token never reaches the
 * browser.
 *
 * Call runPlexPopupFlow directly from a click handler: the popup is opened
 * synchronously, before any await, so browsers don't block it.
 */

const POLL_INTERVAL_MS = 1500;
/** Polls allowed after the popup closes - approval may land just before. */
const POLLS_AFTER_CLOSE = 2;

export type PlexPinStart = { handle: string; authUrl: string; expiresAt: number };

export type PlexPollStep<T> =
	{ status: 'pending' } | { status: 'expired' } | { status: 'done'; value: T };

export type PlexPopupResult<T> =
	{ kind: 'done'; value: T } | { kind: 'blocked' } | { kind: 'cancelled' } | { kind: 'expired' };

function openPopup(): Window | null {
	const width = 600;
	const height = 700;
	const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
	const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
	return window.open(
		'about:blank',
		'cinephage-plex-auth',
		`popup=yes,width=${width},height=${height},left=${left},top=${top}`
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runPlexPopupFlow<T>(options: {
	start: () => Promise<PlexPinStart>;
	poll: (handle: string) => Promise<PlexPollStep<T>>;
	isCancelled?: () => boolean;
}): Promise<PlexPopupResult<T>> {
	const popup = openPopup();
	if (!popup) return { kind: 'blocked' };

	try {
		const pin = await options.start();
		popup.location.href = pin.authUrl;

		let pollsAfterClose = 0;
		while (Date.now() < pin.expiresAt) {
			await sleep(POLL_INTERVAL_MS);
			if (options.isCancelled?.()) return { kind: 'cancelled' };

			const step = await options.poll(pin.handle);
			if (step.status === 'done') return { kind: 'done', value: step.value };
			if (step.status === 'expired') return { kind: 'expired' };

			if (popup.closed && ++pollsAfterClose > POLLS_AFTER_CLOSE) {
				return { kind: 'cancelled' };
			}
		}
		return { kind: 'expired' };
	} finally {
		if (!popup.closed) popup.close();
	}
}
