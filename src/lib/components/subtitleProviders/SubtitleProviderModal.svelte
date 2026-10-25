<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		X,
		Loader2,
		CheckCircle2,
		Globe,
		Key,
		Hash,
		Search,
		User,
		Crown,
		CreditCard
	} from '@lucide/svelte';
	import type {
		SubtitleProviderConfig,
		ProviderImplementation
	} from '#lib/server/subtitles/types.js';
	import type { ProviderDefinition } from '#lib/server/subtitles/providers/interfaces.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { SectionHeader, TestResult } from '#lib/components/ui/modal/index.js';
	import { isBlankOrRedacted, isSensitiveKeyName } from '#lib/shared/sensitiveSettings.js';

	/**
	 * Setting keys that map to dedicated top-level provider config columns
	 * (apiKey/username/password). Providers read these from `config.<key>`, so
	 * the modal must submit them top-level rather than inside `settings`.
	 */
	const AUTH_SETTING_KEYS = new Set(['apiKey', 'username', 'password']);

	function isAuthSettingKey(key: string): boolean {
		return AUTH_SETTING_KEYS.has(key);
	}

	function isSecretSettingKey(key: string): boolean {
		return isSensitiveKeyName(key);
	}

	/**
	 * Get access type info for display
	 */
	function getAccessTypeInfo(def: ProviderDefinition): {
		icon: typeof Globe;
		iconClass: string;
		badge: string;
		badgeClass: string;
	} {
		const accessType =
			def.accessType ??
			(def.requiresApiKey ? 'api-key' : def.requiresCredentials ? 'free-account' : 'free');

		switch (accessType) {
			case 'free':
				return {
					icon: Globe,
					iconClass: 'text-success',
					badge: m.subtitleProviders_modal_accessFree(),
					badgeClass: 'badge-success'
				};
			case 'free-account':
				return {
					icon: User,
					iconClass: 'text-info',
					badge: m.subtitleProviders_modal_accessFreeAccount(),
					badgeClass: 'badge-info'
				};
			case 'api-key':
				return {
					icon: Key,
					iconClass: 'text-warning',
					badge: m.subtitleProviders_modal_accessApiKey(),
					badgeClass: 'badge-warning'
				};
			case 'paid':
				return {
					icon: CreditCard,
					iconClass: 'text-error',
					badge: m.subtitleProviders_modal_accessPaid(),
					badgeClass: 'badge-error'
				};
			case 'vip':
				return {
					icon: Crown,
					iconClass: 'text-secondary',
					badge: m.subtitleProviders_modal_accessVipOnly(),
					badgeClass: 'badge-secondary'
				};
			default:
				return {
					icon: Globe,
					iconClass: 'text-base-content/50',
					badge: m.subtitleProviders_modal_accessUnknown(),
					badgeClass: 'badge-ghost'
				};
		}
	}

	interface SubtitleProviderFormData {
		name: string;
		implementation: string;
		enabled: boolean;
		priority: number;
		apiKey?: string;
		username?: string;
		password?: string;
		requestsPerMinute: number;
		settings?: Record<string, unknown>;
	}

	interface Props {
		open: boolean;
		mode: 'add' | 'edit';
		provider?: SubtitleProviderConfig | null;
		definitions: ProviderDefinition[];
		saving: boolean;
		onClose: () => void;
		onSave: (data: SubtitleProviderFormData) => void;
		onDelete?: () => void;
		onTest: (
			data: SubtitleProviderFormData
		) => Promise<{ success: boolean; error?: string; responseTime?: number }>;
	}

	let {
		open,
		mode,
		provider = null,
		definitions,
		saving,
		onClose,
		onSave,
		onDelete,
		onTest
	}: Props = $props();

	// Form state - Implementation selection (defaults only, effect syncs from props)
	let implementation = $state<ProviderImplementation | ''>('');
	let searchQuery = $state('');

	// Form state - Basic
	let name = $state('');
	let enabled = $state(true);
	let priority = $state(25);

	// Form state - Provider settings (generic `definition.settings`). Values are
	// keyed by setting key; auth keys are mapped to top-level columns on submit.
	let settingValues = $state<Record<string, string | number | boolean>>({});

	// Form state - Rate limiting
	let requestsPerMinute = $state(60);

	// Test state
	let testing = $state(false);
	let testResult = $state<{ success: boolean; error?: string; responseTime?: number } | null>(null);

	// Derived
	const modalTitle = $derived(
		mode === 'add' ? m.subtitleProviders_modal_addTitle() : m.subtitleProviders_modal_editTitle()
	);
	const selectedDefinition = $derived(
		implementation ? definitions.find((d) => d.implementation === implementation) : null
	);
	const requiresApiKey = $derived(selectedDefinition?.requiresApiKey ?? false);
	const requiresCredentials = $derived(selectedDefinition?.requiresCredentials ?? false);
	const declaredSettings = $derived(selectedDefinition?.settings ?? []);
	const MAX_NAME_LENGTH = 15;
	const nameTooLong = $derived(name.length > MAX_NAME_LENGTH);

	/** Whether the stored provider already holds a value for this setting. */
	function settingHasStoredValue(setting: ProviderDefinition['settings'][number]): boolean {
		const existing = isAuthSettingKey(setting.key)
			? (provider as Record<string, unknown> | null)?.[setting.key]
			: provider?.settings?.[setting.key];
		return existing !== undefined && existing !== null && String(existing) !== '';
	}

	/** A required setting is missing when blank (secret blanks keep an existing value). */
	function settingMissing(setting: ProviderDefinition['settings'][number]): boolean {
		const raw = settingValues[setting.key];
		if (setting.type === 'boolean') {
			return setting.required ? raw !== true : false;
		}
		const blank =
			raw === undefined ||
			raw === null ||
			(typeof raw === 'string' && isBlankOrRedacted(raw.trim()));
		if (!blank) return false;
		// Blank secret in edit mode means "keep the stored value".
		if (mode === 'edit' && isSecretSettingKey(setting.key) && settingHasStoredValue(setting)) {
			return false;
		}
		return true;
	}

	const missingRequiredSettings = $derived(
		declaredSettings.filter((s) => s.required && settingMissing(s))
	);
	const canSubmit = $derived(!!name && !nameTooLong && missingRequiredSettings.length === 0);

	// Filter definitions based on search
	const filteredDefinitions = $derived(() => {
		if (!searchQuery.trim()) return definitions;
		const query = searchQuery.toLowerCase();
		return definitions.filter(
			(d) =>
				d.name.toLowerCase().includes(query) ||
				d.description.toLowerCase().includes(query) ||
				d.implementation.toLowerCase().includes(query)
		);
	});

	// Reset form when modal opens or provider changes
	$effect(() => {
		if (open) {
			implementation = provider?.implementation ?? '';
			name = provider?.name ?? '';
			enabled = provider?.enabled ?? true;
			priority = provider?.priority ?? 25;
			requestsPerMinute = provider?.requestsPerMinute ?? 60;
			searchQuery = '';
			testResult = null;
			seedSettingValues(
				provider?.implementation
					? (definitions.find((d) => d.implementation === provider?.implementation) ?? null)
					: null,
				mode,
				provider
			);
		}
	});

	function defaultValueForType(
		type: ProviderDefinition['settings'][number]['type']
	): string | number | boolean {
		switch (type) {
			case 'number':
				return 0;
			case 'boolean':
				return false;
			default:
				return '';
		}
	}

	/**
	 * Build form values for `definition.settings`. Secret settings are left blank
	 * in edit mode so the stored value is only sent when the user types a new one.
	 */
	function seedSettingValues(
		def: ProviderDefinition | null,
		currentMode: 'add' | 'edit',
		currentProvider: SubtitleProviderConfig | null
	) {
		const values: Record<string, string | number | boolean> = {};
		if (def) {
			for (const setting of def.settings) {
				const stored = isAuthSettingKey(setting.key)
					? ((currentProvider as Record<string, unknown> | null)?.[setting.key] as
							string | number | boolean | undefined)
					: (currentProvider?.settings?.[setting.key] as string | number | boolean | undefined);

				const hasStored =
					currentProvider !== null &&
					stored !== undefined &&
					stored !== null &&
					String(stored) !== '';

				if (isSecretSettingKey(setting.key) && currentMode === 'edit' && hasStored) {
					values[setting.key] = '';
					continue;
				}

				if (stored !== undefined && !isBlankOrRedacted(stored)) {
					values[setting.key] = stored;
				} else if (setting.default !== undefined) {
					values[setting.key] = setting.default;
				} else {
					values[setting.key] = defaultValueForType(setting.type);
				}
			}
		}
		settingValues = values;
	}

	function handleImplementationChange(newImpl: ProviderImplementation) {
		implementation = newImpl;
		if (mode === 'add') {
			const def = definitions.find((d) => d.implementation === newImpl);
			if (def) {
				name = def.name;
				requestsPerMinute = def.defaultRequestsPerMinute ?? (newImpl === 'opensubtitles' ? 40 : 60);
				seedSettingValues(def, 'add', null);
			}
		}
	}

	function getFormData(): SubtitleProviderFormData {
		// Preserve undeclared stored settings on edit; declared keys are overwritten.
		const settings: Record<string, unknown> =
			mode === 'edit' && provider?.settings ? { ...provider.settings } : {};

		let apiKey: string | undefined;
		let username: string | undefined;
		let password: string | undefined;

		for (const setting of declaredSettings) {
			const raw = settingValues[setting.key];

			if (isAuthSettingKey(setting.key)) {
				const blank =
					raw === undefined ||
					raw === null ||
					(typeof raw === 'string' && isBlankOrRedacted(raw.trim()));
				if (blank) continue; // edit: undefined keeps the stored value
				if (setting.key === 'apiKey') apiKey = String(raw);
				else if (setting.key === 'username') username = String(raw);
				else if (setting.key === 'password') password = String(raw);
				continue;
			}

			if (
				isSecretSettingKey(setting.key) &&
				typeof raw === 'string' &&
				isBlankOrRedacted(raw.trim())
			) {
				// Blank secret: keep the stored value when editing, otherwise omit.
				const stored = provider?.settings?.[setting.key];
				if (mode === 'edit' && stored !== undefined && !isBlankOrRedacted(stored)) {
					settings[setting.key] = stored;
				}
				continue;
			}

			settings[setting.key] = raw;
		}

		return {
			name,
			implementation,
			enabled,
			priority,
			apiKey,
			username,
			password,
			requestsPerMinute,
			settings: Object.keys(settings).length > 0 ? settings : undefined
		};
	}

	async function handleTest() {
		testing = true;
		testResult = null;
		try {
			testResult = await onTest(getFormData());
		} finally {
			testing = false;
		}
	}

	function handleSave() {
		onSave(getFormData());
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="3xl" labelledBy="subtitle-provider-modal-title">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<h3 id="subtitle-provider-modal-title" class="text-xl font-bold">{modalTitle}</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Provider Type Selection (only in add mode when not selected) -->
	{#if mode === 'add' && !implementation}
		<div class="space-y-4">
			<!-- Search -->
			<div class="form-control">
				<div class="relative">
					<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/50" />
					<input
						type="text"
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						placeholder={m.subtitleProviders_modal_searchPlaceholder()}
						bind:value={searchQuery}
					/>
				</div>
			</div>

			<!-- Provider List -->
			<div class="max-h-100 overflow-y-auto rounded-lg border border-base-300">
				{#each filteredDefinitions() as def (def.implementation)}
					{@const accessInfo = getAccessTypeInfo(def)}
					{@const AccessIcon = accessInfo.icon}
					<button
						type="button"
						class="flex w-full items-center gap-4 border-b border-base-200 p-4 text-left transition-colors last:border-b-0 hover:bg-base-200"
						onclick={() => handleImplementationChange(def.implementation as ProviderImplementation)}
					>
						<div class="rounded-lg bg-base-300 p-2">
							{#if AccessIcon}
								<AccessIcon class="h-5 w-5 {accessInfo.iconClass}" />
							{/if}
						</div>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="font-semibold">{def.name}</span>
								{#if def.supportsHashSearch}
									<span class="badge badge-xs badge-info"
										>{m.subtitleProviders_modal_badgeHash()}</span
									>
								{/if}
							</div>
							<p class="truncate text-sm text-base-content/60">{def.description}</p>
						</div>
						<div class="flex flex-col items-end gap-1">
							<span class="badge badge-sm {accessInfo.badgeClass}">{accessInfo.badge}</span>
							{#if def.requiresCredentials && def.accessType !== 'free-account'}
								<span class="badge badge-ghost badge-xs"
									>{m.subtitleProviders_modal_badgeAccount()}</span
								>
							{/if}
						</div>
					</button>
				{:else}
					<div class="p-8 text-center text-base-content/50">
						{m.subtitleProviders_modal_noMatches({ query: searchQuery })}
					</div>
				{/each}
			</div>

			<p class="text-center text-sm text-base-content/50">
				{m.subtitleProviders_modal_providersAvailable({ count: definitions.length })}
			</p>
		</div>

		<div class="modal-action">
			<button class="btn btn-ghost" onclick={onClose}>{m.subtitleProviders_modal_cancel()}</button>
		</div>
	{:else}
		<!-- Selected provider header (in add mode) -->
		{#if mode === 'add' && selectedDefinition}
			{@const selectedAccessInfo = getAccessTypeInfo(selectedDefinition)}
			{@const SelectedAccessIcon = selectedAccessInfo.icon}
			<div class="mb-6 flex items-center justify-between rounded-lg bg-base-200 px-4 py-3">
				<div class="flex items-center gap-3">
					<div class="rounded-lg bg-base-300 p-2">
						{#if SelectedAccessIcon}
							<SelectedAccessIcon class="h-5 w-5 {selectedAccessInfo.iconClass}" />
						{/if}
					</div>
					<div>
						<div class="flex items-center gap-2">
							<span class="font-semibold">{selectedDefinition.name}</span>
							<span class="badge badge-xs {selectedAccessInfo.badgeClass}"
								>{selectedAccessInfo.badge}</span
							>
						</div>
						<div class="text-sm text-base-content/60">{selectedDefinition.description}</div>
					</div>
				</div>
				<button type="button" class="btn btn-ghost btn-sm" onclick={() => (implementation = '')}>
					{m.subtitleProviders_modal_change()}
				</button>
			</div>
		{/if}

		<!-- Main Form - Responsive Two Column Layout -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
			<!-- Left Column: Basic Settings -->
			<div class="space-y-4">
				<SectionHeader title={m.subtitleProviders_modal_basicSettings()} />

				<div class="form-control">
					<label class="label py-1" for="name">
						<span class="label-text">
							{m.subtitleProviders_modal_name()}
							<span class="text-error">* </span>
						</span>
					</label>
					<input
						id="name"
						type="text"
						class="input-bordered input input-sm"
						bind:value={name}
						maxlength={MAX_NAME_LENGTH}
						placeholder={selectedDefinition?.name ?? 'My Provider'}
					/>
					<div class="label py-1">
						<span
							class="label-text-alt text-xs {nameTooLong ? 'text-error' : 'text-base-content/60'}"
						>
							{name.length}/{MAX_NAME_LENGTH}
						</span>
						{#if nameTooLong}
							<span class="label-text-alt text-xs text-error">
								{m.subtitleProviders_modal_nameTooLong({ max: MAX_NAME_LENGTH })}
							</span>
						{/if}
					</div>
				</div>

				<div class="grid grid-cols-2 gap-2 sm:gap-3">
					<div class="form-control">
						<label class="label py-1" for="priority">
							<span class="label-text">{m.subtitleProviders_modal_priority()}</span>
						</label>
						<input
							id="priority"
							type="number"
							class="input-bordered input input-sm"
							bind:value={priority}
							min="1"
							max="100"
						/>
						<p class="label py-0">
							<span class="label-text-alt text-xs">{m.subtitleProviders_modal_priorityHint()}</span>
						</p>
					</div>

					<div class="form-control">
						<label class="label py-1" for="requestsPerMinute">
							<span class="label-text">{m.subtitleProviders_modal_rateLimit()}</span>
						</label>
						<input
							id="requestsPerMinute"
							type="number"
							class="input-bordered input input-sm"
							bind:value={requestsPerMinute}
							min="1"
							max="300"
						/>
						<p class="label py-0">
							<span class="label-text-alt text-xs"
								>{m.subtitleProviders_modal_requestsPerMin()}</span
							>
						</p>
					</div>
				</div>

				<div class="flex gap-4 pt-2">
					<label class="label cursor-pointer gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={enabled}
						/>
						<span class="label-text">{m.subtitleProviders_modal_enabled()}</span>
					</label>
				</div>
			</div>

			<!-- Right Column: Authentication / Provider Settings -->
			<div class="space-y-4">
				<SectionHeader title={m.subtitleProviders_modal_authentication()} />

				{#if declaredSettings.length > 0}
					<div class="space-y-3">
						{#each declaredSettings as setting (setting.key)}
							<div class="form-control">
								<label class="label py-1" for={`setting-${setting.key}`}>
									<span class="label-text">
										{setting.label}
										{#if setting.required}
											<span class="text-error">* </span>
										{/if}
									</span>
									{#if setting.required}
										<span class="badge badge-xs badge-warning"
											>{m.subtitleProviders_modal_apiKeyRequired()}</span
										>
									{/if}
								</label>

								{#if setting.type === 'boolean'}
									<input
										id={`setting-${setting.key}`}
										type="checkbox"
										class="checkbox checkbox-sm"
										checked={settingValues[setting.key] === true}
										onchange={(e) => (settingValues[setting.key] = e.currentTarget.checked)}
									/>
								{:else if setting.type === 'select'}
									<select
										id={`setting-${setting.key}`}
										class="select-bordered select select-sm"
										value={String(settingValues[setting.key] ?? '')}
										onchange={(e) => (settingValues[setting.key] = e.currentTarget.value)}
									>
										{#each setting.options ?? [] as option (option.value)}
											<option value={option.value}>{option.label}</option>
										{/each}
									</select>
								{:else}
									<input
										id={`setting-${setting.key}`}
										type={isSecretSettingKey(setting.key)
											? 'password'
											: setting.type === 'number'
												? 'number'
												: 'text'}
										class="input-bordered input input-sm"
										value={settingValues[setting.key] as string | number}
										placeholder={isSecretSettingKey(setting.key)
											? mode === 'edit' && settingHasStoredValue(setting)
												? m.subtitleProviders_modal_apiKeyPlaceholderExisting()
												: m.subtitleProviders_modal_apiKeyPlaceholderNew()
											: setting.default !== undefined
												? String(setting.default)
												: ''}
										oninput={(e) =>
											(settingValues[setting.key] =
												setting.type === 'number'
													? e.currentTarget.value === ''
														? ''
														: Number(e.currentTarget.value)
													: e.currentTarget.value)}
									/>
								{/if}

								{#if setting.description}
									<p class="label py-0">
										<span class="label-text-alt text-xs text-base-content/60"
											>{setting.description}</span
										>
									</p>
								{/if}

								{#if isSecretSettingKey(setting.key) && mode === 'edit' && settingHasStoredValue(setting)}
									<p class="label py-0">
										<span class="label-text-alt text-xs opacity-60">({m.auth_blankToKeep()})</span>
									</p>
								{/if}

								{#if setting.key === 'apiKey' && selectedDefinition?.website}
									<p class="label py-1">
										<!-- eslint-disable svelte/no-navigation-without-resolve -- External URL -->
										<a
											href={selectedDefinition.website}
											target="_blank"
											rel="noopener noreferrer"
											class="label-text-alt link text-xs link-primary"
										>
											{m.subtitleProviders_modal_getApiKey({ name: selectedDefinition.name })}
										</a>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									</p>
								{/if}
							</div>
						{/each}
					</div>
				{:else if !requiresApiKey && !requiresCredentials}
					<div class="rounded-lg bg-success/10 p-3">
						<div class="flex items-center gap-2 text-success">
							<CheckCircle2 class="h-4 w-4" />
							<span class="text-sm font-medium">{m.subtitleProviders_modal_noApiKeyRequired()}</span
							>
						</div>
						<p class="mt-1 text-xs text-base-content/60">
							{m.subtitleProviders_modal_noApiKeyDescription()}
						</p>
					</div>
				{/if}

				<!-- Features info -->
				{#if selectedDefinition}
					<SectionHeader title={m.subtitleProviders_modal_features()} class="mt-4" />
					<div class="flex flex-wrap gap-2">
						{#each selectedDefinition.features as feature (feature)}
							<div class="badge badge-outline badge-sm">{feature}</div>
						{/each}
						{#if selectedDefinition.supportsHashSearch}
							<div class="badge gap-1 badge-sm badge-info">
								<Hash class="h-3 w-3" />
								{m.subtitleProviders_modal_badgeHash()}
							</div>
						{/if}
					</div>
					<div class="mt-2 text-xs text-base-content/60">
						{m.subtitleProviders_modal_languagesSupported({
							count: selectedDefinition.supportedLanguages.length
						})}
					</div>
				{/if}
			</div>
		</div>

		<!-- Test Result -->
		<TestResult
			result={testResult}
			successDetails={testResult?.responseTime
				? `Response time: ${testResult.responseTime}ms`
				: undefined}
		/>

		<!-- Actions -->
		<div class="modal-action">
			{#if mode === 'edit' && onDelete}
				<button class="btn mr-auto btn-outline btn-error" onclick={onDelete}
					>{m.subtitleProviders_modal_delete()}</button
				>
			{/if}

			<button class="btn btn-ghost" onclick={handleTest} disabled={testing || saving || !canSubmit}>
				{#if testing}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				{m.subtitleProviders_modal_test()}
			</button>

			<button class="btn btn-ghost" onclick={onClose}>{m.subtitleProviders_modal_cancel()}</button>

			<button class="btn btn-primary" onclick={handleSave} disabled={saving || !canSubmit}>
				{#if saving}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				{m.subtitleProviders_modal_save()}
			</button>
		</div>
	{/if}
</ModalWrapper>
