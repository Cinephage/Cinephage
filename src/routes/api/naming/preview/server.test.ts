/**
 * The naming-settings preview is where users test a format, so every token a
 * season folder can carry has to render a value there. `{SeasonYear}` reads
 * `info.seasonYear`; if the preview sample omits it, the token renders empty
 * and reads as unsupported even though real renames resolve it.
 */

import { describe, it, expect, vi } from 'vitest';
import { api } from '../../../../test/api-helper.js';
import { DEFAULT_NAMING_CONFIG } from '#lib/server/library/naming/NamingService.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';

vi.mock('#lib/logging/index.js', () => {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		fatal: vi.fn(),
		trace: vi.fn(),
		child: vi.fn().mockReturnThis()
	};
	return {
		logger,
		createChildLogger: vi.fn(() => logger),
		createRequestLogger: vi.fn(() => logger),
		runWithLogContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn())
	};
});

vi.mock('#lib/server/library/naming/NamingSettingsService.js', () => ({
	namingSettingsService: {
		getConfig: vi.fn(),
		getPresetSelection: vi.fn()
	}
}));

const { POST } = await import('./+server.js');

interface PreviewPayload {
	previews: {
		series: { folder: string; season: string };
		episode: { file: string };
	};
}

describe('POST /api/naming/preview', () => {
	it('renders {SeasonYear} in the season folder preview', async () => {
		vi.mocked(namingSettingsService.getConfig).mockResolvedValue({
			...DEFAULT_NAMING_CONFIG,
			seasonFolderFormat: 'Season {Season:00} ({SeasonYear})'
		});

		const { status, data } = await api.post<PreviewPayload>(POST, { config: {} });

		expect(status).toBe(200);
		expect(data.previews.series.season).toBe('Season 05 (2012)');
	});
});
