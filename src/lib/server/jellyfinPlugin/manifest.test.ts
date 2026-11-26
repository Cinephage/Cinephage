import { describe, expect, it } from 'vitest';
import {
	CINEPHAGE_PLUGIN_GUID,
	compareVersions,
	pickCompatibleVersion,
	toJellyfinManifest,
	type CinephagePluginPackage,
	type CinephagePluginVersion
} from './manifest.js';

function version(overrides: Partial<CinephagePluginVersion> = {}): CinephagePluginVersion {
	return {
		version: '0.1.0.0',
		targetAbi: '12.4.0.0',
		file: 'cinephage-jellyfin-0.1.0.0.zip',
		checksum: 'a'.repeat(32),
		timestamp: '2026-01-01T00:00:00Z',
		changelog: 'test',
		...overrides
	};
}

describe('compareVersions', () => {
	it('orders dotted versions by component, padding missing parts with zero', () => {
		expect(compareVersions('12.4.0.0', '12.4.0')).toBe(0);
		expect(compareVersions('12.4.1.0', '12.4.0.9')).toBeGreaterThan(0);
		expect(compareVersions('10.11.9.0', '12.4.0.0')).toBeLessThan(0);
	});
});

describe('pickCompatibleVersion', () => {
	it('picks the newest build the server ABI can run', () => {
		const versions = [
			version({ version: '0.1.0.0', targetAbi: '12.4.0.0', file: 'a.zip' }),
			version({ version: '0.2.0.0', targetAbi: '12.6.0.0', file: 'b.zip' })
		];

		expect(pickCompatibleVersion(versions, '12.4.0')?.file).toBe('a.zip');
		expect(pickCompatibleVersion(versions, '12.5.0.0')?.file).toBe('a.zip');
		expect(pickCompatibleVersion(versions, '12.6.1')?.file).toBe('b.zip');
	});

	it('returns null when every build needs a newer server', () => {
		expect(pickCompatibleVersion([version({ targetAbi: '12.4.0.0' })], '12.3.7')).toBeNull();
	});
});

describe('toJellyfinManifest', () => {
	it('renders the array shape Jellyfin reads, with absolute source URLs', () => {
		const pkg: CinephagePluginPackage = {
			guid: CINEPHAGE_PLUGIN_GUID,
			name: 'Cinephage',
			description: 'description',
			overview: 'overview',
			owner: 'Cinephage',
			category: 'General',
			versions: [version()]
		};

		const [manifest] = toJellyfinManifest(pkg, 'http://192.168.1.10:3000');

		expect(manifest.guid).toBe(CINEPHAGE_PLUGIN_GUID);
		expect(manifest.versions).toHaveLength(1);
		expect(manifest.versions[0].sourceUrl).toBe(
			'http://192.168.1.10:3000/api/jellyfin-plugin/packages/cinephage-jellyfin-0.1.0.0.zip'
		);
		expect(manifest.versions[0]).not.toHaveProperty('file');
	});
});
