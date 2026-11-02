/**
 * Radarr/Sonarr-compatible `system/status` response.
 *
 * Field set and enum values confirmed against Radarr/Radarr's and
 * Sonarr/Sonarr's actual openapi.json (SystemResource, RuntimeMode,
 * DatabaseType, AuthenticationType, UpdateMechanism). This is
 * the first (and for some clients, only) call an arr-satellite tool makes
 * when validating a connection - the "Test" button in autobrr's arr
 * settings, Overseerr's server check, etc. `appName` is the field some
 * stricter clients use to confirm they're talking to the arr they think
 * they configured, so it's the one field that genuinely differs between
 * the two personas; everything else is shared, honest-effort metadata.
 */

import { resolveAppVersion } from '#lib/server/version.js';

export type ArrAppName = 'Radarr' | 'Sonarr';

const startTime = new Date().toISOString();

export function buildSystemStatus(appName: ArrAppName) {
	return {
		appName,
		instanceName: 'Cinephage',
		version: resolveAppVersion(),
		buildTime: startTime,
		isDebug: false,
		isProduction: true,
		isAdmin: false,
		isUserInteractive: false,
		startupPath: '/',
		appData: '/config',
		osName: 'linux',
		osVersion: '',
		isNetCore: true,
		isLinux: true,
		isOsx: false,
		isWindows: false,
		isDocker: true,
		// RuntimeMode enum: console | service | tray
		mode: 'console',
		branch: 'main',
		// DatabaseType enum: sqLite | postgreSQL - exact casing matters
		databaseType: 'sqLite',
		databaseVersion: '3',
		// Sonarr's SystemResource carries this legacy field alongside
		// databaseType/databaseVersion; Radarr's doesn't.
		sqliteVersion: '3',
		// AuthenticationType enum: none | basic | forms | external - this
		// describes the *web UI* login method (Cinephage has a /login page),
		// not per-request API-key auth, which is a separate mechanism.
		authentication: 'forms',
		migrationVersion: 1,
		urlBase: '',
		runtimeVersion: process.version,
		runtimeName: 'node',
		startTime,
		packageVersion: resolveAppVersion(),
		packageAuthor: 'Cinephage',
		// UpdateMechanism enum: builtIn | script | external | apt | docker
		packageUpdateMechanism: 'docker',
		packageUpdateMechanismMessage: null
	};
}
