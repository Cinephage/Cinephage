// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';
import SubtitleProviderModal from './SubtitleProviderModal.svelte';
import type { ProviderDefinition } from '#lib/server/subtitles/providers/interfaces.js';
import type { SubtitleProviderConfig } from '#lib/server/subtitles/types.js';

const assrtDefinition: ProviderDefinition = {
	implementation: 'assrt',
	name: 'Assrt',
	description: 'Chinese subtitle provider',
	website: 'https://assrt.net',
	requiresApiKey: true,
	requiresCredentials: false,
	accessType: 'api-key',
	supportedLanguages: ['zh', 'en'] as ProviderDefinition['supportedLanguages'],
	supportsHashSearch: false,
	features: [],
	settings: [
		{
			key: 'token',
			label: 'API Token',
			type: 'string',
			required: true,
			description: 'Your Assrt API token'
		}
	]
};

const opensubtitlesDefinition: ProviderDefinition = {
	implementation: 'opensubtitles',
	name: 'OpenSubtitles',
	description: 'Largest subtitle database',
	website: 'https://www.opensubtitles.com',
	requiresApiKey: true,
	requiresCredentials: false,
	accessType: 'api-key',
	supportedLanguages: ['en'] as ProviderDefinition['supportedLanguages'],
	supportsHashSearch: true,
	features: [],
	settings: [
		{ key: 'apiKey', label: 'API Key', type: 'string', required: true },
		{ key: 'username', label: 'Username', type: 'string', required: false },
		{ key: 'password', label: 'Password', type: 'string', required: false }
	]
};

const napiprojektDefinition: ProviderDefinition = {
	implementation: 'napiprojekt',
	name: 'Napiprojekt',
	description: 'Polish provider',
	website: 'https://napiprojekt.pl',
	requiresApiKey: false,
	requiresCredentials: false,
	accessType: 'free',
	supportedLanguages: ['pl'] as ProviderDefinition['supportedLanguages'],
	supportsHashSearch: false,
	features: [],
	settings: [
		{ key: 'onlyAuthors', label: 'Only Authors', type: 'boolean', required: false },
		{
			key: 'mode',
			label: 'Mode',
			type: 'select',
			required: false,
			options: [
				{ value: 'fast', label: 'Fast' },
				{ value: 'accurate', label: 'Accurate' }
			]
		}
	]
};

function makeProvider(overrides: Partial<SubtitleProviderConfig> = {}): SubtitleProviderConfig {
	return {
		id: 'provider-1',
		name: 'Provider One',
		implementation: 'assrt',
		enabled: true,
		priority: 25,
		requestsPerMinute: 60,
		consecutiveFailures: 0,
		...overrides
	};
}

function renderModal(
	definitions: ProviderDefinition[],
	provider: SubtitleProviderConfig | null,
	overrides: Record<string, unknown> = {}
) {
	const onSave = vi.fn();
	const onTest = vi.fn().mockResolvedValue({ success: true, responseTime: 5 });
	render(SubtitleProviderModal, {
		props: {
			open: true,
			mode: provider ? 'edit' : 'add',
			provider,
			definitions,
			saving: false,
			onClose: vi.fn(),
			onSave,
			onTest,
			...overrides
		}
	});
	return { onSave, onTest };
}

afterEach(() => {
	cleanup();
});

describe('SubtitleProviderModal generic settings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders a token-style setting with masking, required marker, and description', () => {
		renderModal([assrtDefinition], makeProvider({ settings: { token: 'stored-token' } }));

		const input = screen.getByLabelText(/API Token/) as HTMLInputElement;
		expect(input).toBeTruthy();
		expect(input.type).toBe('password');
		// Secret stored values are not prefilled in edit mode.
		expect(input.value).toBe('');
		expect(screen.getByText('Required')).toBeTruthy();
		expect(screen.getByText('Your Assrt API token')).toBeTruthy();
	});

	it('persists a newly typed token into settings on save', async () => {
		const { onSave } = renderModal(
			[assrtDefinition],
			makeProvider({ settings: { token: 'stored-token' } })
		);

		const input = screen.getByLabelText(/API Token/) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'new-token' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0]).toMatchObject({ settings: { token: 'new-token' } });
	});

	it('keeps the stored token when the secret field is left blank in edit mode', async () => {
		const { onSave } = renderModal(
			[assrtDefinition],
			makeProvider({ settings: { token: 'stored-token' } })
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(onSave.mock.calls[0][0]).toMatchObject({ settings: { token: 'stored-token' } });
	});

	it('blocks saving a required setting until it is filled', async () => {
		renderModal([assrtDefinition], makeProvider({ settings: undefined }));

		const saveButton = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(saveButton.disabled).toBe(true);

		const input = screen.getByLabelText(/API Token/) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'fresh-token' } });

		expect(saveButton.disabled).toBe(false);
	});

	it('maps an apiKey setting to the dedicated top-level column', async () => {
		const { onSave } = renderModal(
			[opensubtitlesDefinition],
			makeProvider({ implementation: 'opensubtitles', apiKey: 'stored-key' })
		);

		const input = screen.getByLabelText(/^API Key/) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'new-api-key' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		const payload = onSave.mock.calls[0][0] as Record<string, unknown>;
		expect(payload.apiKey).toBe('new-api-key');
		expect((payload.settings as Record<string, unknown> | undefined)?.apiKey).toBeUndefined();
	});

	it('renders and persists boolean and select settings', async () => {
		const { onSave } = renderModal(
			[napiprojektDefinition],
			makeProvider({ implementation: 'napiprojekt', settings: {} })
		);

		const checkbox = screen.getByLabelText(/Only Authors/) as HTMLInputElement;
		expect(checkbox.type).toBe('checkbox');
		expect(checkbox.checked).toBe(false);
		await fireEvent.click(checkbox);

		const select = screen.getByLabelText(/Mode/) as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: 'accurate' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(onSave.mock.calls[0][0]).toMatchObject({
			settings: { onlyAuthors: true, mode: 'accurate' }
		});
	});

	it('persists an untouched boolean as false (does not drop it)', async () => {
		const { onSave } = renderModal(
			[napiprojektDefinition],
			makeProvider({ implementation: 'napiprojekt', settings: {} })
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		const settings = (onSave.mock.calls[0][0] as { settings: Record<string, unknown> }).settings;
		expect(settings.onlyAuthors).toBe(false);
	});
});
