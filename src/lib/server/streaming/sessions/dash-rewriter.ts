import type { PlaybackSession, SessionResourceKind } from '../types';

/**
 * DASH (MPD) manifest rewriter.
 *
 * Mirrors playlist-rewriter.ts for MPEG-DASH. Every segment/media URL in the
 * MPD is rewritten through the playback session so that:
 *   - same-origin URLs under the MPD's directory become
 *     /api/streaming/session/{token}/dash/{relative-path} - a template-safe
 *     catch-all that preserves $Number$/$Time$ placeholders (which a
 *     registered-resource route cannot, since concrete numbers arrive only at
 *     request time)
 *   - any other URL is registered as a session resource and served through
 *     /api/streaming/session/{token}/segment/{id}.{ext}
 *
 * This matters for signed CDNs (e.g. CloudFront cookie auth): the client can
 * only fetch segments through our proxy, which attaches the session headers.
 */

interface RewriteDashOptions {
	mpd: string;
	mpdUrl: string;
	baseUrl: string;
	session: PlaybackSession;
	apiKey?: string;
	registerResource: (url: string, kind: SessionResourceKind, extension: string) => string;
}

const DASH_SEGMENT_EXTENSIONS = new Set(['m4s', 'mp4', 'm4a', 'm4v', 'aac', 'mp3', 'webm', 'ts']);

function inferExtension(url: string): string {
	try {
		const pathname = new URL(url).pathname;
		const lastSegment = pathname.split('/').pop() ?? '';
		const match = lastSegment.match(/\.([a-zA-Z0-9]+)$/);
		return match?.[1]?.toLowerCase() ?? 'bin';
	} catch {
		return 'bin';
	}
}

export function rewriteDashManifest(options: RewriteDashOptions): string {
	const base = new URL(options.mpdUrl);
	const origin = base.origin;
	const mpdDirPath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

	/** Preserve a reverse-proxy subpath configured in the base URL. */
	function resolveAgainstBase(path: string): URL {
		const normalizedBase = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		return new URL(path.replace(/^\/+/, ''), normalizedBase);
	}

	function buildDashProxyUrl(relativePath: string): string {
		const url = resolveAgainstBase(
			`api/streaming/session/${options.session.token}/dash/${relativePath}`
		);
		if (options.apiKey) {
			url.searchParams.set('api_key', options.apiKey);
		}
		return url.toString();
	}

	function buildRegisteredUrl(absoluteUrl: string): string {
		const extension = DASH_SEGMENT_EXTENSIONS.has(inferExtension(absoluteUrl))
			? inferExtension(absoluteUrl)
			: 'bin';
		const resourceId = options.registerResource(absoluteUrl, 'segment', extension);
		const url = resolveAgainstBase(
			`api/streaming/session/${options.session.token}/segment/${resourceId}.${extension}`
		);
		if (options.apiKey) {
			url.searchParams.set('api_key', options.apiKey);
		}
		let output = url.toString();
		const templateParameters = new Map<string, string>();
		for (const match of absoluteUrl.matchAll(/\$([A-Za-z][A-Za-z0-9]*)(?:%0\d+d)?\$/g)) {
			templateParameters.set(match[1], match[0]);
		}
		for (const [name, template] of templateParameters) {
			output += `${output.includes('?') ? '&' : '?'}dash_${encodeURIComponent(name)}=${template}`;
		}
		return output;
	}

	/**
	 * Rewrite a single URL (which may be a relative path, an absolute URL, or
	 * a template containing $Number$/$Time$ placeholders). Returns the
	 * rewritten session URL, or the original value when it cannot be proxied.
	 */
	function rewriteUrl(rawValue: string): string {
		const trimmed = rawValue.trim();
		if (!trimmed) {
			return rawValue;
		}

		let resolved: URL;
		try {
			resolved = new URL(trimmed, options.mpdUrl);
		} catch {
			return rawValue;
		}

		// Non-HTTP values (data: URIs, URNs, fragments) pass through.
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
			return rawValue;
		}

		// Same-origin, under the MPD's directory -> template-safe catch-all.
		// An empty relative path (BaseURL pointing at the MPD's own directory)
		// is rewritten too, so the client resolves media templates against the
		// session-proxied root rather than the CDN.
		if (resolved.origin === origin && resolved.pathname.startsWith(mpdDirPath)) {
			return buildDashProxyUrl(
				`${resolved.pathname.slice(mpdDirPath.length)}${resolved.search}${resolved.hash}`
			);
		}

		// Anything else -> registered session resource.
		return buildRegisteredUrl(resolved.toString());
	}

	// <BaseURL> elements carry the URL as text content.
	let rewritten = options.mpd.replace(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/gi, (match, content) => {
		if (!content.trim()) {
			return match;
		}
		// Function replacement avoids $ patterns in templates being treated
		// as special substitution sequences.
		return match.replace(content, () => rewriteUrl(content));
	});

	// SegmentTemplate@media (may contain $Number$/$Time$), SegmentURL@media,
	// SegmentTemplate@initialization and Initialization@sourceURL.
	rewritten = rewritten.replace(
		/(\b(?:media|sourceURL|initialization)\s*=\s*")([^"]*)(")/gi,
		(_match, prefix, value, suffix) => {
			return `${prefix}${rewriteUrl(value)}${suffix}`;
		}
	);

	return rewritten;
}
