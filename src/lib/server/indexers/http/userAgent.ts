/**
 * User-Agent sent with indexer requests.
 *
 * Indexers sit behind bot management (Cloudflare, DDoS-Guard). Announcing
 * "Cinephage/1.0" is a bot signature: RuTracker answers it with a Turnstile
 * challenge on every forum path, while the same cookies and IP pass with a
 * browser UA. Jackett and Prowlarr send browser UAs for the same reason.
 *
 * This is not impersonation for its own sake — it is the minimum a client must
 * look like to be served the HTML the parsers were written against.
 */
export const INDEXER_USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
