<script lang="ts">
	import { X, Loader2, XCircle, Tv, Radio, List, Globe } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { TestResult } from '#lib/components/ui/modal/index.js';
	import LiveTvProviderPicker from './LiveTvProviderPicker.svelte';
	import StalkerAccountForm from './forms/StalkerAccountForm.svelte';
	import XstreamAccountForm from './forms/XstreamAccountForm.svelte';
	import M3uAccountForm from './forms/M3uAccountForm.svelte';
	import CinephageIptvAccountForm from './forms/CinephageIptvAccountForm.svelte';
	import { getProviderDefinition } from './providerDefinitions';
	import type {
		LiveTvAccount,
		LiveTvProviderType,
		LiveTvAccountTestResult
	} from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';
	import { isBlankOrRedacted, REDACTED_VALUE } from '#lib/shared/sensitiveSettings.js';
	import { formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		open: boolean;
		mode: 'add' | 'edit';
		account?: LiveTvAccount | null;
		saving: boolean;
		error?: string | null;
		onClose: () => void;
		onSave: (data: FormData) => void;
		onDelete?: () => void;
		onTest: (data: TestConfig) => Promise<LiveTvAccountTestResult>;
	}

	export interface FormData {
		name: string;
		providerType: LiveTvProviderType;
		portalUrl?: string;
		macAddress?: string;
		baseUrl?: string;
		username?: string;
		password?: string;
		url?: string;
		fileContent?: string;
		epgUrl: string;
		autoRefresh: boolean;
		enabled: boolean;
		/** Stalker portal UI language (2-letter code); defaults to 'en'. */
		language?: string;
		cinephageIptvConfig?: { countries: string[] };
	}

	export interface TestConfig {
		providerType: LiveTvProviderType;
		/** Stored account to resolve [REDACTED] secrets against (edit mode). */
		accountId?: string;
		portalUrl?: string;
		macAddress?: string;
		baseUrl?: string;
		username?: string;
		password?: string;
		url?: string;
		fileContent?: string;
		epgUrl?: string;
		/** Stalker portal UI language (2-letter code); defaults to 'en'. */
		language?: string;
		cinephageIptvConfig?: { countries: string[] };
	}

	let {
		open,
		mode,
		account = null,
		saving,
		error = null,
		onClose,
		onSave,
		onDelete,
		onTest
	}: Props = $props();

	// Provider selection state
	let selectedProvider = $state<LiveTvProviderType | ''>('');

	// Common form state
	let name = $state('');
	let enabled = $state(true);
	let epgUrl = $state('');

	// Stalker form state
	let portalUrl = $state('');
	let macAddress = $state('');
	let language = $state('en');

	// XStream form state
	let baseUrl = $state('');
	let username = $state('');
	let password = $state('');

	// M3U form state
	let inputMode = $state<'url' | 'file'>('url');
	let url = $state('');
	let fileContent = $state('');
	let fileName = $state('');
	let autoRefresh = $state(false);

	// Cinephage IPTV form state
	let selectedCountries = $state<string[]>([]);

	// UI state
	let testing = $state(false);
	let testResult = $state<LiveTvAccountTestResult | null>(null);

	// Derived
	const modalTitle = $derived(
		mode === 'add' ? m.livetv_accountModal_addTitle() : m.livetv_accountModal_editTitle()
	);
	const providerDef = $derived(selectedProvider ? getProviderDefinition(selectedProvider) : null);
	// Reset form when modal opens
	$effect(() => {
		if (open) {
			// Set provider type
			if (mode === 'edit' && account) {
				selectedProvider = account.providerType;
				inputMode = account.m3uConfig?.url ? 'url' : 'file';
			} else {
				selectedProvider = '';
				inputMode = 'url';
			}

			// Common fields
			name = account?.name ?? '';
			enabled = account?.enabled ?? true;
			epgUrl = account?.m3uConfig?.epgUrl ?? account?.xstreamConfig?.epgUrl ?? '';

			// Stalker fields
			portalUrl = account?.stalkerConfig?.portalUrl ?? '';
			macAddress = account?.stalkerConfig?.macAddress ?? '';
			language = account?.stalkerConfig?.language ?? 'en';

			// XStream fields
			baseUrl = account?.xstreamConfig?.baseUrl ?? '';
			username = account?.xstreamConfig?.username ?? '';
			password = '';

			// M3U fields
			url = account?.m3uConfig?.url ?? '';
			fileContent = account?.m3uConfig?.fileContent ?? '';
			fileName = '';
			autoRefresh = account?.m3uConfig?.autoRefresh ?? false;

			// Cinephage IPTV fields
			if (account?.providerType === 'cinephage-iptv') {
				selectedCountries = account.cinephageIptvConfig?.countries ?? [];
			} else {
				selectedCountries = [];
			}

			// Reset UI state
			testing = false;
			testResult = null;
		}
	});

	// Validation
	const isStalkerValid = $derived(
		name.trim().length > 0 && portalUrl.trim().length > 0 && macAddress.trim().length > 0
	);
	const isXstreamValid = $derived(
		name.trim().length > 0 &&
			baseUrl.trim().length > 0 &&
			username.trim().length > 0 &&
			(mode === 'add' || !isBlankOrRedacted(password?.trim()) || !!account?.xstreamConfig?.password)
	);
	const isM3uValid = $derived(() => {
		if (name.trim().length === 0) return false;
		if (inputMode === 'url') return url.trim().length > 0;
		return fileContent.length > 0;
	});

	const isCinephageIptvValid = $derived(name.trim().length > 0 && selectedCountries.length > 0);

	const canSubmit = $derived(() => {
		switch (selectedProvider) {
			case 'stalker':
				return isStalkerValid;
			case 'xstream':
				return isXstreamValid;
			case 'm3u':
				return isM3uValid();
			case 'cinephage-iptv':
				return isCinephageIptvValid;
			default:
				return false;
		}
	});

	function getFormData(): FormData {
		const data: FormData = {
			name: name.trim(),
			providerType: selectedProvider as LiveTvProviderType,
			epgUrl: epgUrl.trim(),
			autoRefresh,
			enabled
		};

		switch (selectedProvider) {
			case 'stalker':
				data.portalUrl = portalUrl.trim();
				data.macAddress = macAddress.toUpperCase();
				data.language = language;
				break;
			case 'xstream':
				data.baseUrl = baseUrl.trim();
				data.username = username.trim();
				if (!isBlankOrRedacted(password?.trim())) {
					data.password = password.trim();
				}
				break;
			case 'm3u':
				if (inputMode === 'url') {
					data.url = url.trim();
				} else {
					data.fileContent = fileContent;
				}
				break;
			case 'cinephage-iptv':
				data.cinephageIptvConfig = { countries: selectedCountries };
				break;
		}

		return data;
	}

	function getTestConfig(): TestConfig {
		const config: TestConfig = {
			providerType: selectedProvider as LiveTvProviderType
		};

		// In edit mode the stored credential never reaches this browser, so an
		// untouched password field tests against the server-side value via the
		// redaction marker + accountId.
		if (mode === 'edit' && account) {
			config.accountId = account.id;
		}

		switch (selectedProvider) {
			case 'stalker':
				config.portalUrl = portalUrl.trim();
				config.macAddress = macAddress.toUpperCase();
				config.language = language;
				break;
			case 'xstream':
				config.baseUrl = baseUrl.trim();
				config.username = username.trim();
				config.password = isBlankOrRedacted(password?.trim()) ? REDACTED_VALUE : password.trim();
				if (epgUrl.trim()) {
					config.epgUrl = epgUrl.trim();
				}
				break;
			case 'm3u':
				if (epgUrl.trim()) {
					config.epgUrl = epgUrl.trim();
				}
				if (inputMode === 'url') {
					config.url = url.trim();
				} else {
					config.fileContent = fileContent;
				}
				break;
			case 'cinephage-iptv':
				config.cinephageIptvConfig = { countries: selectedCountries };
				break;
		}

		return config;
	}

	function getSuccessMessage(result: LiveTvAccountTestResult | null): string {
		if (!result?.profile) {
			return m.livetv_accountModal_testSuccess();
		}

		const statuses = [
			result.profile.streamVerified
				? m.livetv_accountModal_streamVerified()
				: m.livetv_accountModal_streamNotVerified()
		];
		const epgStatus = result.profile.epg?.status;
		if (epgStatus === 'reachable') {
			statuses.push(m.livetv_accountModal_epgReachable());
		} else if (epgStatus === 'unreachable') {
			statuses.push(m.livetv_accountModal_epgUnreachable());
		} else if (epgStatus === 'not_configured') {
			statuses.push(m.livetv_accountModal_epgNotConfigured());
		}

		return m.livetv_accountModal_testSuccessWithStatus({ status: statuses.join(' • ') });
	}

	function getSuccessDetails(result: LiveTvAccountTestResult | null): string | undefined {
		if (!result?.profile) {
			return undefined;
		}

		const details = [
			m.livetv_accountModal_channelCount({ count: result.profile.channelCount }),
			m.livetv_accountModal_categoryCount({ count: result.profile.categoryCount })
		];

		if (result.profile.expiresAt) {
			details.push(
				m.livetv_accountModal_expires({
					date: formatDisplayDate(result.profile.expiresAt)
				})
			);
		}

		const epgStatus = result.profile.epg?.status;
		if (epgStatus === 'reachable') {
			details.push(
				result.profile.epg?.source === 'playlist-header'
					? m.livetv_accountModal_epgSourcePlaylist()
					: m.livetv_accountModal_epgSourceUrl()
			);
		} else if (epgStatus === 'unreachable' && result.profile.epg?.error) {
			details.push(m.livetv_accountModal_epgError({ error: result.profile.epg.error }));
		}

		return details.join(' • ');
	}

	async function handleTest() {
		if (!canSubmit()) return;

		testing = true;
		testResult = null;

		try {
			testResult = await onTest(getTestConfig());
		} finally {
			testing = false;
		}
	}

	function handleSave() {
		if (!canSubmit()) return;
		onSave(getFormData());
	}

	function handleProviderSelect(type: LiveTvProviderType) {
		selectedProvider = type;
		testResult = null;
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="3xl" labelledBy="livetv-account-modal-title">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<h3 id="livetv-account-modal-title" class="text-xl font-bold">{modalTitle}</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Provider Selection (add mode only) -->
	{#if mode === 'add' && !selectedProvider}
		<LiveTvProviderPicker onSelect={handleProviderSelect} onCancel={onClose} />
	{:else}
		<!-- Provider Header (with change button in add mode) -->
		{#if providerDef}
			<div class="mb-6 flex items-center justify-between rounded-lg bg-base-200 px-4 py-3">
				<div class="flex items-center gap-3">
					<div class="rounded-lg bg-primary/10 p-2">
						{#if selectedProvider === 'stalker'}
							<Tv class="h-5 w-5 text-primary" />
						{:else if selectedProvider === 'xstream'}
							<Radio class="h-5 w-5 text-primary" />
						{:else if selectedProvider === 'm3u'}
							<List class="h-5 w-5 text-primary" />
						{:else if selectedProvider === 'cinephage-iptv'}
							<Globe class="h-5 w-5 text-primary" />
						{/if}
					</div>
					<div>
						<div class="font-semibold">{providerDef.name}</div>
						<div class="text-sm text-base-content/60">{providerDef.description}</div>
					</div>
				</div>
				{#if mode === 'add'}
					<button
						type="button"
						class="btn btn-ghost btn-sm"
						onclick={() => (selectedProvider = '')}
					>
						{m.livetv_accountModal_changeButton()}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Form Content -->
		{#if selectedProvider === 'stalker'}
			<StalkerAccountForm
				{name}
				{portalUrl}
				{macAddress}
				{epgUrl}
				{enabled}
				{language}
				{mode}
				onNameChange={(v) => (name = v)}
				onPortalUrlChange={(v) => (portalUrl = v)}
				onMacAddressChange={(v) => (macAddress = v)}
				onEpgUrlChange={(v) => (epgUrl = v)}
				onEnabledChange={(v) => (enabled = v)}
				onLanguageChange={(v) => (language = v)}
			/>
		{:else if selectedProvider === 'xstream'}
			<XstreamAccountForm
				{name}
				{baseUrl}
				{username}
				{password}
				{epgUrl}
				{enabled}
				{mode}
				hasPassword={!!account?.xstreamConfig?.password}
				onNameChange={(v) => (name = v)}
				onBaseUrlChange={(v) => (baseUrl = v)}
				onUsernameChange={(v) => (username = v)}
				onPasswordChange={(v) => (password = v)}
				onEpgUrlChange={(v) => (epgUrl = v)}
				onEnabledChange={(v) => (enabled = v)}
			/>
		{:else if selectedProvider === 'm3u'}
			<M3uAccountForm
				{name}
				{inputMode}
				{url}
				{fileContent}
				{fileName}
				{epgUrl}
				{autoRefresh}
				{enabled}
				{mode}
				onNameChange={(v) => (name = v)}
				onInputModeChange={(m) => {
					inputMode = m;
					testResult = null;
				}}
				onUrlChange={(v) => (url = v)}
				onFileUpload={(content, name) => {
					fileContent = content;
					fileName = name;
				}}
				onEpgUrlChange={(v) => (epgUrl = v)}
				onAutoRefreshChange={(v) => (autoRefresh = v)}
				onEnabledChange={(v) => (enabled = v)}
			/>
		{:else if selectedProvider === 'cinephage-iptv'}
			<CinephageIptvAccountForm
				{name}
				{selectedCountries}
				{enabled}
				{mode}
				onNameChange={(v) => (name = v)}
				onCountriesChange={(v) => (selectedCountries = v)}
				onEnabledChange={(v) => (enabled = v)}
			/>
		{/if}

		<!-- Save Error -->
		{#if error}
			<div class="mt-6 alert alert-error">
				<XCircle class="h-5 w-5" />
				<div>
					<div class="font-medium">{m.livetv_accountModal_failedToSave()}</div>
					<div class="text-sm opacity-80">{error}</div>
				</div>
			</div>
		{/if}

		<!-- Test Result -->
		<TestResult
			result={testResult
				? {
						success: testResult.success,
						error: testResult.error
					}
				: null}
			successMessage={getSuccessMessage(testResult)}
			successDetails={getSuccessDetails(testResult)}
		/>

		<!-- Actions -->
		<div class="modal-action flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center">
			{#if mode === 'edit' && onDelete}
				<button class="btn w-full btn-outline btn-error sm:mr-auto sm:w-auto" onclick={onDelete}>
					Delete
				</button>
			{/if}

			<button
				class="btn w-full btn-ghost sm:w-auto"
				onclick={handleTest}
				disabled={testing || saving || !canSubmit()}
			>
				{#if testing}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				Test
			</button>

			<button class="btn w-full btn-ghost sm:w-auto" onclick={onClose}>Cancel</button>

			<button
				class="btn w-full btn-primary sm:w-auto"
				onclick={handleSave}
				disabled={saving || !canSubmit()}
			>
				{#if saving}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				Save
			</button>
		</div>
	{/if}
</ModalWrapper>
