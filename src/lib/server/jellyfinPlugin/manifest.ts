/**
 * The Cinephage Jellyfin plugin package.
 *
 * `jellyfin-plugin/` builds one manifest per supported Jellyfin ABI into
 * `jellyfin-plugin/dist/<targetAbi>/`. This module reads those builds and
 * renders the manifest shape Jellyfin's plugin repository loader expects. The
 * app serves it at /api/jellyfin-plugin/manifest.json so a Jellyfin server can
 * install the plugin without the user downloading anything by hand.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const CINEPHAGE_PLUGIN_GUID = 'd912b3f3-fc4c-4c74-90e1-678616b8fe9f';
export const CINEPHAGE_PLUGIN_NAME = 'Cinephage';

const PLUGIN_DIST_DIR = join(process.cwd(), 'jellyfin-plugin', 'dist');

export interface CinephagePluginVersion {
	version: string;
	targetAbi: string;
	file: string;
	checksum: string;
	timestamp: string;
	changelog: string;
}

export interface CinephagePluginPackage {
	guid: string;
	name: string;
	description: string;
	overview: string;
	owner: string;
	category: string;
	versions: CinephagePluginVersion[];
}

export interface CinephagePluginBuild {
	pkg: CinephagePluginPackage;
	/** Absolute path of each version's zip, keyed by the manifest's `file`. */
	files: Map<string, string>;
}

export interface JellyfinPluginManifestVersion extends Omit<CinephagePluginVersion, 'file'> {
	sourceUrl: string;
}

export interface JellyfinPluginManifestPackage extends Omit<CinephagePluginPackage, 'versions'> {
	versions: JellyfinPluginManifestVersion[];
}

function versionParts(value: string): number[] {
	return value
		.split(/[.+-]/)
		.map((part) => Number.parseInt(part, 10))
		.filter((part) => Number.isFinite(part));
}

/** Compares dotted versions by component; missing components count as zero. */
export function compareVersions(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	const length = Math.max(left.length, right.length);

	for (let index = 0; index < length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}

	return 0;
}

/**
 * Picks the newest build whose target ABI is not newer than the server.
 * A Jellyfin server refuses plugins built for a newer ABI, so the ceiling is
 * the server version, not the plugin version.
 */
export function pickCompatibleVersion(
	versions: CinephagePluginVersion[],
	serverVersion: string | null | undefined
): CinephagePluginVersion | null {
	const ordered = [...versions].sort((a, b) => compareVersions(b.version, a.version));
	if (!serverVersion) return ordered[0] ?? null;
	return ordered.find((version) => compareVersions(version.targetAbi, serverVersion) <= 0) ?? null;
}

/** Renders the array shape Jellyfin's manifest loader deserializes. */
export function toJellyfinManifest(
	build: CinephagePluginPackage,
	origin: string
): JellyfinPluginManifestPackage[] {
	return [
		{
			guid: build.guid,
			name: build.name,
			description: build.description,
			overview: build.overview,
			owner: build.owner,
			category: build.category,
			versions: build.versions.map(({ file, ...version }) => ({
				...version,
				sourceUrl: `${origin}/api/jellyfin-plugin/packages/${encodeURIComponent(file)}`
			}))
		}
	];
}

/**
 * Reads every built ABI manifest under `jellyfin-plugin/dist`. Missing or
 * unreadable builds are skipped: an install request then reports "not bundled"
 * instead of serving a broken repository.
 */
export async function readPluginBuild(): Promise<CinephagePluginBuild | null> {
	let directories;
	try {
		directories = await readdir(PLUGIN_DIST_DIR, { withFileTypes: true });
	} catch {
		return null;
	}

	let pkg: CinephagePluginPackage | null = null;
	const files = new Map<string, string>();

	for (const directory of directories) {
		if (!directory.isDirectory()) continue;

		const directoryPath = join(PLUGIN_DIST_DIR, directory.name);
		let manifest: unknown;
		try {
			manifest = JSON.parse(await readFile(join(directoryPath, 'manifest.json'), 'utf8'));
		} catch {
			continue;
		}

		const entry = Array.isArray(manifest) ? manifest[0] : null;
		if (!entry || entry.guid !== CINEPHAGE_PLUGIN_GUID || !Array.isArray(entry.versions)) {
			continue;
		}

		pkg ??= {
			guid: entry.guid,
			name: entry.name,
			description: entry.description,
			overview: entry.overview,
			owner: entry.owner,
			category: entry.category,
			versions: []
		};

		for (const version of entry.versions as CinephagePluginVersion[]) {
			if (!version?.version || !version.file) continue;
			pkg.versions.push(version);
			files.set(version.file, join(directoryPath, version.file));
		}
	}

	if (!pkg || pkg.versions.length === 0) return null;

	pkg.versions.sort((a, b) => compareVersions(b.version, a.version));
	return { pkg, files };
}

/**
 * Resolves a package file named by the manifest. Only names the manifest
 * declares are served: the request path never becomes a filesystem path.
 */
export async function readPluginPackage(file: string): Promise<Buffer | null> {
	if (basename(file) !== file) return null;

	const build = await readPluginBuild();
	const path = build?.files.get(file);
	if (!path) return null;

	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
		return await readFile(path);
	} catch {
		return null;
	}
}
