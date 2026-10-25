import { describe, expect, it } from 'vitest';
import { clientDefinitions } from './forms/clientDefinitions';
import { serializeDownloadClientForm, type DownloadClientFormState } from './formSerializer';

function formState(overrides: Record<string, unknown> = {}): DownloadClientFormState {
	return {
		name: ' qBit ',
		enabled: true,
		host: ' localhost ',
		port: 8080,
		useSsl: false,
		urlBase: '/qb/',
		urlBaseEnabled: true,
		mountMode: '',
		username: ' admin ',
		password: 'password',
		movieCategory: 'movies',
		tvCategory: 'tv',
		recentPriority: 'high',
		olderPriority: 'normal',
		initialState: 'start',
		sequentialDownload: false,
		downloadPathLocal: '/downloads',
		downloadPathRemote: '/remote',
		tempPathLocal: '/incomplete',
		tempPathRemote: '/remote-incomplete',
		maxConnections: 10,
		priority: 2,
		implementation: 'qbittorrent',
		...overrides
	} as DownloadClientFormState;
}

describe('debrid download-client definitions and serialization', () => {
	it.each([
		['realdebrid', 'Real-Debrid'],
		['torbox', 'TorBox']
	] as const)('%s is a first-class debrid picker definition', (id, name) => {
		const definition = clientDefinitions.find((candidate) => candidate.id === id);

		expect(definition).toEqual(
			expect.objectContaining({
				id,
				name,
				protocol: 'debrid',
				isDebrid: true,
				supportsCategories: false,
				supportsSeedingLimits: false
			})
		);
	});

	it('serializes a debrid form using only the approved fields', () => {
		const payload = serializeDownloadClientForm(
			formState({
				name: ' Real-Debrid ',
				implementation: 'realdebrid',
				apiToken: ' rd-secret ',
				removeAfterImport: true
			} as Record<string, unknown>),
			false,
			'add'
		);

		expect(payload).toEqual({
			name: 'Real-Debrid',
			implementation: 'realdebrid',
			enabled: true,
			priority: 2,
			apiToken: 'rd-secret',
			removeAfterImport: true
		});
		expect(JSON.stringify(payload)).not.toContain('localhost');
	});

	it.each(['', '   ', '********'])(
		'omits a blank/redacted token on debrid edit: %j',
		(apiToken) => {
			const payload = serializeDownloadClientForm(
				formState({ implementation: 'torbox', apiToken, removeAfterImport: false }),
				false,
				'edit'
			) as unknown as Record<string, unknown>;

			expect(payload).toEqual({
				name: 'qBit',
				implementation: 'torbox',
				enabled: true,
				priority: 2,
				removeAfterImport: false
			});
			expect(payload).not.toHaveProperty('apiToken');
		}
	);

	it('keeps legacy torrent serialization unchanged', () => {
		expect(serializeDownloadClientForm(formState(), false, 'add')).toEqual({
			name: 'qBit',
			implementation: 'qbittorrent',
			enabled: true,
			host: 'localhost',
			port: 8080,
			useSsl: false,
			urlBase: 'qb',
			mountMode: null,
			username: 'admin',
			password: 'password',
			movieCategory: 'movies',
			tvCategory: 'tv',
			recentPriority: 'high',
			olderPriority: 'normal',
			initialState: 'start',
			seedRatioLimit: null,
			seedTimeLimit: null,
			sequentialDownload: false,
			// Untouched legacy forms keep the historical auto-removal behavior.
			removeAfterImport: true,
			downloadPathLocal: '/downloads',
			downloadPathRemote: '/remote',
			tempPathLocal: '/incomplete',
			tempPathRemote: '/remote-incomplete',
			priority: 2
		});
	});

	it('serializes seed goals and removal policy for torrent clients', () => {
		const data = serializeDownloadClientForm(
			{
				...formState(),
				seedRatioLimit: ' 1.5 ',
				seedTimeLimit: ' 4320 ',
				removeAfterImport: false
			},
			false,
			'edit'
		);

		expect(data).toMatchObject({
			seedRatioLimit: '1.5',
			seedTimeLimit: 4320,
			removeAfterImport: false
		});
	});
});
