import { describe, expect, it } from 'vitest';
import { yamlDefinitionSchema } from './schema/yamlDefinition.js';
import { declaredSeedLimits } from './seedDefaults';

/** Build a real definition object so the test also pins the YAML shape. */
function definition(fields: Record<string, unknown>) {
	return yamlDefinitionSchema.parse({
		id: 'test-indexer',
		name: 'Test Indexer',
		links: ['https://tracker.example/'],
		caps: {},
		search: { fields }
	});
}

describe('declaredSeedLimits', () => {
	it('reads a static ratio and a seed time, converting seconds to minutes', () => {
		const limits = declaredSeedLimits(
			definition({
				minimumratio: { text: '1.0' },
				minimumseedtime: { text: '864000' }
			})
		);

		expect(limits.ratio).toBe('1.0');
		expect(limits.seedTimeMinutes).toBe(14400);
	});

	it('accepts numeric text, which the YAML schema allows', () => {
		const limits = declaredSeedLimits(
			definition({
				minimumratio: { text: 0.8 },
				minimumseedtime: { text: 345600 }
			})
		);

		expect(limits.ratio).toBe('0.8');
		expect(limits.seedTimeMinutes).toBe(5760);
	});

	it('accepts the plain-string field form', () => {
		const limits = declaredSeedLimits(definition({ minimumratio: '1.1', minimumseedtime: '172800' }));

		expect(limits.ratio).toBe('1.1');
		expect(limits.seedTimeMinutes).toBe(2880);
	});

	it('omits a ratioless declaration instead of storing "0"', () => {
		// nebulance declares minimumratio: '0'. Stored, that becomes a share limit of
		// ratio 0, which stops the torrent immediately in qBittorrent and Deluge.
		const limits = declaredSeedLimits(definition({ minimumratio: { text: '0' } }));

		expect(limits.ratio).toBeUndefined();
	});

	it('ignores a per-release seed time driven by a selector', () => {
		// nebulance: 120h for season packs, 24h for episodes. Picking one at creation
		// time would be wrong for half the grabs.
		const limits = declaredSeedLimits(
			definition({
				minimumseedtime: {
					selector: 'cat',
					case: { SEASON: '432000', '*': '86400' }
				}
			})
		);

		expect(limits.seedTimeMinutes).toBeUndefined();
	});

	it('ignores a templated value', () => {
		const limits = declaredSeedLimits(
			definition({ minimumratio: { text: '{{ .Result.ratio }}' }, minimumseedtime: '{{ .Config.time }}' })
		);

		expect(limits.ratio).toBeUndefined();
		expect(limits.seedTimeMinutes).toBeUndefined();
	});

	it('returns nothing when the definition declares nothing', () => {
		expect(declaredSeedLimits(definition({ title: { selector: 'a.title' } }))).toEqual({});
	});

	it('returns nothing when the search block declares no seeking fields', () => {
		const def = yamlDefinitionSchema.parse({
			id: 'bare',
			name: 'Bare',
			links: ['https://example.test/'],
			caps: {},
			search: {}
		});

		expect(declaredSeedLimits(def)).toEqual({});
	});

	it('never rounds a sub-minute requirement down to zero', () => {
		const limits = declaredSeedLimits(definition({ minimumseedtime: { text: '30' } }));

		expect(limits.seedTimeMinutes).toBe(1);
	});
});
