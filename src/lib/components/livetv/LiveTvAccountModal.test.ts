// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import LiveTvAccountModal from './LiveTvAccountModal.svelte';
import type { FormData } from './LiveTvAccountModal.svelte';
import type { LiveTvAccount } from '#lib/types/livetv.js';

function makeStalkerAccount(
	stalkerConfig: Partial<NonNullable<LiveTvAccount['stalkerConfig']>> = {}
): LiveTvAccount {
	return {
		id: 'stalker-account',
		name: 'My Portal',
		providerType: 'stalker',
		enabled: true,
		stalkerConfig: {
			portalUrl: 'http://portal.example.com/c',
			macAddress: '00:1A:79:00:00:01',
			...stalkerConfig
		},
		playbackLimit: null,
		channelCount: null,
		categoryCount: null,
		expiresAt: null,
		serverTimezone: null,
		lastTestedAt: null,
		lastTestSuccess: null,
		lastTestError: null,
		lastSyncAt: null,
		lastSyncError: null,
		syncStatus: 'never',
		lastEpgSyncAt: null,
		lastEpgSyncError: null,
		epgProgramCount: 0,
		hasEpg: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
}

function renderModal(account: LiveTvAccount, onSave: (data: FormData) => void) {
	return render(LiveTvAccountModal, {
		props: {
			open: true,
			mode: 'edit',
			account,
			saving: false,
			error: null,
			onClose: vi.fn(),
			onSave,
			onDelete: vi.fn(),
			onTest: vi.fn().mockResolvedValue({ success: true })
		}
	});
}

function getLanguageSelect(): HTMLSelectElement {
	return screen.getByLabelText('Language') as HTMLSelectElement;
}

function clickSave() {
	return fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

function payloadOf(onSave: ReturnType<typeof vi.fn>, call: number): FormData {
	expect(onSave.mock.calls.length).toBeGreaterThanOrEqual(call + 1);
	return onSave.mock.calls[call][0] as FormData;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('LiveTvAccountModal stalker language field', () => {
	it('includes the persisted language in the saved payload', async () => {
		const onSave = vi.fn<(data: FormData) => void>();
		renderModal(makeStalkerAccount({ language: 'ru' }), onSave);

		expect(getLanguageSelect().value).toBe('ru');

		await clickSave();

		const payload = payloadOf(onSave, 0);
		expect(payload.providerType).toBe('stalker');
		expect(payload.portalUrl).toBe('http://portal.example.com/c');
		expect(payload.macAddress).toBe('00:1A:79:00:00:01');
		expect(payload.language).toBe('ru');
	});

	it('defaults the language to English for old accounts without the field', async () => {
		const onSave = vi.fn<(data: FormData) => void>();
		renderModal(makeStalkerAccount(), onSave);

		expect(getLanguageSelect().value).toBe('en');

		await clickSave();

		expect(payloadOf(onSave, 0).language).toBe('en');
	});

	it('sends the newly selected language in the saved payload', async () => {
		const onSave = vi.fn<(data: FormData) => void>();
		renderModal(makeStalkerAccount(), onSave);

		await fireEvent.change(getLanguageSelect(), { target: { value: 'de' } });
		await clickSave();

		expect(payloadOf(onSave, 0).language).toBe('de');
	});
});
