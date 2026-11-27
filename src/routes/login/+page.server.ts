import { resolveAppVersion } from '#lib/server/version.js';
import { isSetupComplete } from '#lib/server/auth/setup.js';
import { mediaServerLinkService } from '#lib/server/mediaServerLink/MediaServerLinkService.js';

export async function load() {
	let plexSignIn = false;
	try {
		plexSignIn = (await isSetupComplete()) && (await mediaServerLinkService.hasPlexSignInServer());
	} catch {
		// Login must render even if this lookup fails; just hide the button.
	}
	return { version: resolveAppVersion(), plexSignIn };
}
