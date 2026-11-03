import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { YamlDefinitionLoader } from '../loader/YamlDefinitionLoader.js';
import { FilterEngine } from '../engine/FilterEngine.js';
import { TemplateEngine } from '../engine/TemplateEngine.js';
import type { FilterBlock } from '../schema/yamlDefinition.js';

const definitionPath = resolve('data/indexers/definitions/rutracker.yaml');

async function loadTitleFilters(): Promise<FilterBlock[]> {
	const loader = new YamlDefinitionLoader(resolve('data/indexers/definitions'));
	const result = await loader.loadOne(definitionPath);
	expect(result).not.toBeNull();
	const titleField = result!.definition.search?.fields?.title;
	expect(titleField).toBeDefined();
	expect(typeof titleField).not.toBe('string');
	const filters =
		typeof titleField === 'string'
			? undefined
			: (titleField as { filters?: FilterBlock[] }).filters;
	expect(filters).toBeDefined();
	return filters ?? [];
}

function engineWithConfig(stripcyrillic: boolean): FilterEngine {
	const templateEngine = new TemplateEngine();
	templateEngine.setVariables({ Config: { stripcyrillic } });
	return new FilterEngine(templateEngine);
}

describe('RuTracker title filters - dub-studio normalization', () => {
	it('normalizes Cyrillic dub words to latin tokens that survive Cyrillic stripping', async () => {
		const filters = await loadTitleFilters();
		const engine = engineWithConfig(true);

		const result = engine.applyFilters(
			'Титаник / Titanic (1997) BDRip [H.264] [Дубляж + Авторский + Многоголосый + Двухголосый + Одноголосый]',
			filters
		);

		expect(result).toContain('DUB');
		expect(result).toContain('AVO');
		expect(result).toContain('MVO');
		expect(result).toContain('DVO');
		expect(result).toContain('VO');
	});

	it('transliterates dub-studio names (kinozal parity)', async () => {
		const filters = await loadTitleFilters();
		const engine = engineWithConfig(true);

		const result = engine.applyFilters(
			'Мулан / Mulan (1998) BDRip [MVO (Кубик в Кубе) + AVO (Кураж-Бамбей) + MVO (Кравец) + DVO (Пифагор) + VO (Невафильм)]',
			filters
		);

		expect(result).toContain('Kubik');
		expect(result).toContain('kurazh');
		expect(result).toContain('Kravec');
		expect(result).toContain('Pifagor');
		expect(result).toContain('Nevafilm');
	});

	it('maps standalone Cyrillic dub abbreviations with word boundaries', async () => {
		const filters = await loadTitleFilters();
		const engine = engineWithConfig(true);

		const result = engine.applyFilters(
			'Гладиатор / Gladiator (2000) BDRip [АП + ЛМ + ДБ + СТ]',
			filters
		);

		expect(result).toContain('AVO');
		expect(result).toContain('MVO');
		expect(result).toContain('DUB');
		expect(result).toContain('Sub');
	});

	it('does not corrupt Cyrillic words containing dub-abbreviation letters', async () => {
		const filters = await loadTitleFilters();
		const engine = engineWithConfig(false);

		const result = engine.applyFilters(
			'Настоящая любовь / True Romance (1993) СТРИМ VHSRip ПОРТАЛ',
			filters
		);

		expect(result).toContain('СТРИМ');
		expect(result).toContain('ПОРТАЛ');
	});

	it('keeps the Russian title intact when Cyrillic is not stripped', async () => {
		const filters = await loadTitleFilters();
		const engine = engineWithConfig(false);

		const input = 'Друзья / Friends (1994) BDRip [MVO (Кравец) + Дубляж]';
		const result = engine.applyFilters(input, filters);

		expect(result).not.toBe('');
		expect(result).toContain('Друзья');
		expect(result).toContain('Kravec');
		expect(result).toContain('DUB');
	});
});
