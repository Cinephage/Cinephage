// No 'unsafe-inline' in script-src: the only inline script the app ever had
// (the anti-flash theme bootstrap) moved to static/theme-init.js so an
// injected inline script gets zero CSP friction nowhere. If a future feature
// truly needs inline scripts, prefer hashes or nonces over re-adding
// 'unsafe-inline'. Styles keep 'unsafe-inline' (Tailwind + component styles).
// Browsers ignore HSTS on plain-http responses, so it is safe to send
// unconditionally; https deployments get the upgrade enforcement.
const CSP_HEADER = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https: http:",
	"connect-src 'self'",
	"font-src 'self'",
	"media-src 'self' blob: https: http:",
	"object-src 'none'",
	"child-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
	"frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
	"frame-ancestors 'self'"
].join('; ');

const SECURITY_HEADERS = {
	'X-Frame-Options': 'SAMEORIGIN',
	'X-Content-Type-Options': 'nosniff',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
	'Content-Security-Policy': CSP_HEADER
};

const BASE_SECURITY_HEADERS = {
	'X-Frame-Options': 'SAMEORIGIN',
	'X-Content-Type-Options': 'nosniff',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
	'Referrer-Policy': 'strict-origin-when-cross-origin'
};

export { CSP_HEADER, SECURITY_HEADERS, BASE_SECURITY_HEADERS };
