import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';

const definitionsDir = resolve('data/indexers/definitions');

describe('RuTracker login form', () => {
	it('submits the remember-me checkbox so the session cookie is long-lived', async () => {
		const loader = new YamlDefinitionLoader(definitionsDir);
		const loaded = await loader.loadOne(resolve(definitionsDir, 'rutracker.yaml'));

		const login = loaded?.definition.login;
		expect(login?.method).toBe('form');
		expect(login?.inputs).toMatchObject({
			login_username: '{{ .Config.username }}',
			login_password: '{{ .Config.password }}',
			autologin: 'on'
		});
	});
});
