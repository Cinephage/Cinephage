import type { Reroute } from '@sveltejs/kit/hooks';

/**
 * Universal hooks (shared by client and server) - this is the only file
 * SvelteKit reads `reroute`/`transport` from. `hooks.server.ts` only
 * supplies `handle`/`handleError`; exporting `reroute` there is silently
 * ignored since routing happens before `handle` ever runs.
 */

// Arr-compat path casing only — unsupported, non-priority.
// Cinephage's own behavior takes precedence over arr expectations
// when the two conflict. Policy: src/lib/server/arr/arrCompatSettings.ts.
//
// Real Radarr/Sonarr run on ASP.NET Core, which routes case-insensitively
// by default - arr clients (Jellyseerr/Overseerr(Seerr), autobrr, ...) rely on that
// and send segments like `qualityProfile` instead of the lowercase route
// folder names used here (e.g. `qualityprofile`). SvelteKit's file-based
// router is case-sensitive, so normalize arr-compat path casing here,
// before routing happens, to match real arr behavior.
export const reroute: Reroute = ({ url }) => {
	if (url.pathname.startsWith('/api/radarr/') || url.pathname.startsWith('/api/sonarr/')) {
		return url.pathname.toLowerCase();
	}
	return url.pathname;
};
