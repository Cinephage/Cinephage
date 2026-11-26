import { describe, expect, it } from 'vitest';
import { selectCurrentPlugin } from './cinephagePlugin.js';

const GUID = 'd912b3f3fc4c4c7490e1678616b8fe9f';

function plugin(overrides: Partial<{ Id: string; Version: string; Status: string }> = {}) {
	return {
		Name: 'Cinephage',
		Version: '0.1.0.0',
		Description: 'test',
		Id: GUID,
		Status: 'Active',
		...overrides
	};
}

describe('selectCurrentPlugin', () => {
	it('picks the new version during an update, not the superseded one', () => {
		const plugins = [
			plugin({ Version: '0.1.0.0', Status: 'Superseded' }),
			plugin({ Version: '0.1.1.0', Status: 'Restart' })
		];

		expect(selectCurrentPlugin(plugins)?.Version).toBe('0.1.1.0');
		expect(selectCurrentPlugin(plugins)?.Status).toBe('Restart');
	});

	it('returns null when the plugin is not installed', () => {
		expect(selectCurrentPlugin([plugin({ Id: 'a'.repeat(32) })])).toBeNull();
		expect(selectCurrentPlugin([])).toBeNull();
	});
});
