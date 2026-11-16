/**
 * Custom server entry point for production.
 *
 * This wraps the SvelteKit adapter-node server to configure HTTP settings
 * that improve compatibility with reverse proxies like Nginx.
 *
 * Issue: Node.js has a default keepAliveTimeout of 5 seconds, but reverse
 * proxies (Nginx, Traefik, etc.) typically use 60-75 seconds. This mismatch
 * causes 502 Bad Gateway errors when the proxy tries to reuse a connection
 * that Node already closed.
 *
 * Solution: Set keepAliveTimeout higher than the proxy's timeout.
 */

// Load .env into process.env before any application code runs.
// In dev Vite handles this automatically; in production we need it explicitly.
// If no .env file exists (e.g. Docker with env vars passed directly), this is a no-op.
import 'dotenv/config';

// Raise the default request body limit. adapter-node reads BODY_SIZE_LIMIT when
// its bundle loads, so this must be set BEFORE the dynamic import below (ESM
// static imports are hoisted and would load the bundle too early). Bulk import
// submits one batch of up to 5000 jobs, which can exceed the 512K default.
process.env.BODY_SIZE_LIMIT ??= '10M';

// KeepAlive note: Node's default keepAliveTimeout is 5s, but reverse proxies
// (Nginx, Traefik) typically use 60-75s. The mismatch causes 502 Bad Gateway
// errors on connection reuse; keepAliveTimeout is raised to 65s below.
// adapter-node 6 exports the underlying http.Server directly (kit 2 wrapped
// it in a ServerApp object, hence the removed `.server` indirection here).
// adapter-node 6 does not read the ORIGIN env when it builds a request URL: it takes
// the Host header and assumes https unless PROTOCOL_HEADER names a header it can read.
// A direct plain-HTTP install therefore mints https:// URLs for the stream proxy, .strm
// files and the Live TV playlist, pointing clients at a TLS port that does not exist.
// Expose the protocol the socket actually used. A deployment that sets PROTOCOL_HEADER
// itself keeps its own value and this block stays out of the way.
const SOCKET_PROTOCOL_HEADER = 'x-cinephage-proto';
const deriveProtocolFromSocket = !process.env.PROTOCOL_HEADER;
if (deriveProtocolFromSocket) process.env.PROTOCOL_HEADER = SOCKET_PROTOCOL_HEADER;

const server = (await import('./build/index.js')).server;

if (deriveProtocolFromSocket) {
	// Runs ahead of adapter-node's own request listener, so the header is in place
	// before the adapter resolves the origin. A proxy that states the scheme wins;
	// one that only forwards a host keeps the adapter's previous behaviour.
	server.prependListener('request', (req) => {
		const headers = req.headers;
		if (!headers || headers[SOCKET_PROTOCOL_HEADER]) return;
		const forwarded = (headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
		if (forwarded === 'http' || forwarded === 'https') {
			headers[SOCKET_PROTOCOL_HEADER] = forwarded;
		} else if (!headers['x-forwarded-host'] && !headers['forwarded']) {
			headers[SOCKET_PROTOCOL_HEADER] = req.socket?.encrypted ? 'https' : 'http';
		}
	});
}

// Set keepAliveTimeout to 65 seconds (higher than typical proxy timeouts of 60s)
// This prevents 502 errors from connection reuse issues
server.keepAliveTimeout = 65000;

// headersTimeout must be higher than keepAliveTimeout
// This is how long the server waits for request headers
server.headersTimeout = 66000;

console.log('Server configured with keepAliveTimeout=65s for reverse proxy compatibility');
console.log(`Body size limit: ${process.env.BODY_SIZE_LIMIT}`);
