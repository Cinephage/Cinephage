<script lang="ts">
	import { X, Loader2, XCircle, Plus, Trash2 } from '@lucide/svelte';
	import type {
		MediaBrowserServerPublic,
		MediaBrowserServerType,
		MediaBrowserPathMapping,
		MediaBrowserTestResult
	} from '#lib/server/notifications/mediabrowser/types.js';
	import { isBlankOrRedacted } from '#lib/shared/sensitiveSettings.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { SectionHeader, TestResult, ToggleSetting } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';

	interface MediaBrowserFormData {
		name: string;
		serverType: MediaBrowserServerType;
		host: string;
		apiKey: string;
		enabled: boolean;
		onImport: boolean;
		onUpgrade: boolean;
		onRename: boolean;
		onDelete: boolean;
		pathMappings: MediaBrowserPathMapping[];
	}

	interface Props {
		open: boolean;
		mode: 'add' | 'edit';
		server?: MediaBrowserServerPublic | null;
		saving: boolean;
		error?: string | null;
		onClose: () => void;
		onSave: (data: MediaBrowserFormData) => void;
		onDelete?: () => void;
		onTest: (data: MediaBrowserFormData) => Promise<MediaBrowserTestResult>;
	}

	let {
		open,
		mode,
		server = null,
		saving,
		error = null,
		onClose,
		onSave,
		onDelete,
		onTest
	}: Props = $props();

	// Form state - Server type selection
	let serverType = $state<MediaBrowserServerType | ''>('');

	// Form state - Basic
	let name = $state('');
	let host = $state('http://localhost:8096');
	let apiKey = $state('');
	let enabled = $state(true);

	// Form state - Event triggers
	let onImport = $state(true);
	let onUpgrade = $state(true);
	let onRename = $state(true);
	let onDelete_ = $state(true);

	// Form state - Path mappings
	let pathMappings = $state<MediaBrowserPathMapping[]>([]);

	// UI state
	let testing = $state(false);
	let testResult = $state<MediaBrowserTestResult | null>(null);
	const MAX_NAME_LENGTH = 20;
	const nameTooLong = $derived(name.length > MAX_NAME_LENGTH);

	// Derived
	const modalTitle = $derived(
		mode === 'add' ? m.mediaBrowser_addServer() : m.mediaBrowser_editServer()
	);
	const hasApiKey = $derived(mode === 'edit' && !!server?.id);

	// Reset form when modal opens or server changes
	$effect(() => {
		if (open) {
			serverType = server?.serverType ?? '';
			name = server?.name ?? '';
			host = server?.host ?? 'http://localhost:8096';
			apiKey = '';
			enabled = server?.enabled ?? true;
			onImport = server?.onImport ?? true;
			onUpgrade = server?.onUpgrade ?? true;
			onRename = server?.onRename ?? true;
			onDelete_ = server?.onDelete ?? true;
			pathMappings = server?.pathMappings ? [...server.pathMappings] : [];
			testResult = null;
		}
	});

	function handleServerTypeChange(type: MediaBrowserServerType) {
		serverType = type;
		if (mode === 'add') {
			name = type === 'jellyfin' ? 'Jellyfin' : type === 'emby' ? 'Emby' : 'Plex';
			host = type === 'plex' ? 'http://localhost:32400' : 'http://localhost:8096';
		}
	}

	function getServerTypeName(type: MediaBrowserServerType): string {
		return type === 'jellyfin' ? 'Jellyfin' : type === 'emby' ? 'Emby' : 'Plex';
	}

	function getServerTypeBadge(type: MediaBrowserServerType): string {
		return type === 'jellyfin'
			? 'badge-primary'
			: type === 'emby'
				? 'badge-secondary'
				: 'badge-accent';
	}

	function addPathMapping() {
		pathMappings = [...pathMappings, { localPath: '', remotePath: '' }];
	}

	function removePathMapping(index: number) {
		pathMappings = pathMappings.filter((_, i) => i !== index);
	}

	function updatePathMapping(index: number, field: 'localPath' | 'remotePath', value: string) {
		pathMappings = pathMappings.map((mapping, i) =>
			i === index ? { ...mapping, [field]: value } : mapping
		);
	}

	function getFormData(): MediaBrowserFormData {
		const data: MediaBrowserFormData = {
			name,
			serverType: serverType as MediaBrowserServerType,
			host,
			apiKey: isBlankOrRedacted(apiKey?.trim()) ? '' : apiKey.trim(),
			enabled,
			onImport,
			onUpgrade,
			onRename,
			onDelete: onDelete_,
			pathMappings: pathMappings.filter((m) => m.localPath && m.remotePath)
		};
		return data;
	}

	async function handleTest() {
		testing = true;
		testResult = null;
		try {
			testResult = await onTest(getFormData());
			// The running server decides its type: connect/test probes the
			// product and adopts what actually answered (Jellyfin vs Emby vs
			// Plex) instead of trusting the picker.
			const detected = testResult?.serverInfo?.detectedType;
			if (testResult?.success && detected && detected !== serverType) {
				serverType = detected;
			}
		} finally {
			testing = false;
		}
	}

	function handleSave() {
		onSave(getFormData());
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="3xl" labelledBy="media-browser-modal-title">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<h3 id="media-browser-modal-title" class="text-xl font-bold">{modalTitle}</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Server Type Selection (only in add mode when not selected) -->
	{#if mode === 'add' && !serverType}
		<div class="space-y-4">
			<p class="text-base-content/70">{m.mediaBrowser_selectServerType()}</p>

			<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
				<button
					type="button"
					class="card cursor-pointer border-2 border-transparent bg-base-200 text-left transition-all hover:border-primary hover:bg-primary/10"
					onclick={() => handleServerTypeChange('jellyfin')}
				>
					<div class="card-body p-4">
						<div class="flex-1">
							<h3 class="font-semibold">{m.mediaBrowser_serverType_jellyfin()}</h3>
							<p class="mt-1 text-sm text-base-content/60">
								{m.mediaBrowser_serverType_jellyfinDesc()}
							</p>
						</div>
					</div>
				</button>

				<button
					type="button"
					class="card cursor-pointer border-2 border-transparent bg-base-200 text-left transition-all hover:border-secondary hover:bg-secondary/10"
					onclick={() => handleServerTypeChange('emby')}
				>
					<div class="card-body p-4">
						<div class="flex-1">
							<h3 class="font-semibold">{m.mediaBrowser_serverType_emby()}</h3>
							<p class="mt-1 text-sm text-base-content/60">
								{m.mediaBrowser_serverType_embyDesc()}
							</p>
						</div>
					</div>
				</button>

				<button
					type="button"
					class="card cursor-pointer border-2 border-transparent bg-base-200 text-left transition-all hover:border-accent hover:bg-accent/10"
					onclick={() => handleServerTypeChange('plex')}
				>
					<div class="card-body p-4">
						<div class="flex-1">
							<h3 class="font-semibold">{m.mediaBrowser_serverType_plex()}</h3>
							<p class="mt-1 text-sm text-base-content/60">
								{m.mediaBrowser_serverType_plexDesc()}
							</p>
						</div>
					</div>
				</button>
			</div>
		</div>

		<div class="modal-action">
			<button class="btn btn-ghost" onclick={onClose}>Cancel</button>
		</div>
	{:else}
		<!-- Selected server type header (in add mode) -->
		{#if mode === 'add' && serverType}
			<div class="mb-6 flex items-center justify-between rounded-lg bg-base-200 px-4 py-3">
				<div class="flex items-center gap-3">
					<div class="font-semibold">
						{getServerTypeName(serverType as MediaBrowserServerType)}
					</div>
					<div class="badge badge-sm {getServerTypeBadge(serverType as MediaBrowserServerType)}">
						Media Server
					</div>
				</div>
				<button type="button" class="btn btn-ghost btn-sm" onclick={() => (serverType = '')}>
					{m.action_change()}
				</button>
			</div>
		{/if}

		<!-- Main Form - Responsive Two Column Layout -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
			<!-- Left Column: Connection -->
			<div class="space-y-4">
				<SectionHeader title={m.mediaBrowser_connection()} />

				<div class="form-control">
					<label class="label py-1" for="name">
						<span class="label-text">
							{m.common_name()}
							<span class="text-error">* </span>
						</span>
					</label>
					<input
						id="name"
						type="text"
						class="input-bordered input input-sm"
						bind:value={name}
						maxlength={MAX_NAME_LENGTH}
						placeholder={serverType ? getServerTypeName(serverType as MediaBrowserServerType) : ''}
					/>
					<div class="label py-1">
						<span
							class="label-text-alt text-xs {nameTooLong ? 'text-error' : 'text-base-content/60'}"
						>
							{m.mediaBrowser_nameLength({ current: name.length, max: MAX_NAME_LENGTH })}
						</span>
						{#if nameTooLong}
							<span class="label-text-alt text-xs text-error"
								>{m.mediaBrowser_nameTooLong({ max: MAX_NAME_LENGTH })}</span
							>
						{/if}
					</div>
				</div>

				<div class="form-control">
					<label class="label py-1" for="host">
						<span class="label-text">
							{m.mediaBrowser_host()}
							<span class="text-error">* </span>
						</span>
					</label>
					<input
						id="host"
						type="text"
						class="input-bordered input input-sm"
						bind:value={host}
						placeholder={serverType === 'plex' ? 'http://localhost:32400' : 'http://localhost:8096'}
					/>
					<div class="label py-1">
						<span class="label-text-alt text-xs"> {m.mediaBrowser_hostHint()} </span>
					</div>
				</div>

				<div class="form-control">
					<label class="label py-1" for="apiKey">
						<span class="label-text">
							{m.mediaBrowser_apiKey()}
							{#if mode === 'add' || !hasApiKey}
								<span class="text-error">* </span>
							{/if}
							{#if mode === 'edit' && hasApiKey}
								<span class="text-xs opacity-50">({m.auth_blankToKeep()})</span>
							{/if}
						</span>
					</label>
					<input
						id="apiKey"
						type="password"
						class="input-bordered input input-sm"
						bind:value={apiKey}
						placeholder={mode === 'edit' && hasApiKey
							? '********'
							: m.mediaBrowser_apiKeyPlaceholder()}
					/>
					<div class="label py-1">
						<span class="label-text-alt text-xs">
							{serverType === 'plex'
								? m.mediaBrowser_apiKeyHelpPlex()
								: m.mediaBrowser_apiKeyHelpGeneric()}
						</span>
					</div>
				</div>

				<label class="label cursor-pointer gap-2">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						bind:checked={enabled}
					/>
					<span class="label-text">{m.common_enabled()}</span>
				</label>
			</div>

			<!-- Right Column: Settings -->
			<div class="space-y-4">
				<SectionHeader title={m.mediaBrowser_notificationEvents()} />

				<ToggleSetting
					bind:checked={onImport}
					label={m.mediaBrowser_event_import()}
					description={m.mediaBrowser_event_importDesc()}
				/>

				<ToggleSetting
					bind:checked={onUpgrade}
					label={m.mediaBrowser_event_upgrade()}
					description={m.mediaBrowser_event_upgradeDesc()}
				/>

				<ToggleSetting
					bind:checked={onRename}
					label={m.mediaBrowser_event_rename()}
					description={m.mediaBrowser_event_renameDesc()}
				/>

				<ToggleSetting
					bind:checked={onDelete_}
					label={m.mediaBrowser_event_delete()}
					description={m.mediaBrowser_event_deleteDesc()}
				/>
			</div>
		</div>

		<!-- Path Mappings Section -->
		<div class="mt-6 space-y-4">
			<div class="flex items-center justify-between">
				<SectionHeader title={m.mediaBrowser_pathMappings()} />
				<button type="button" class="btn btn-ghost btn-sm" onclick={addPathMapping}>
					<Plus class="h-4 w-4" />
					{m.mediaBrowser_addMapping()}
				</button>
			</div>

			<p class="text-sm text-base-content/60">
				{m.mediaBrowser_pathMappingsDesc()}
			</p>

			{#if pathMappings.length > 0}
				<div class="space-y-2">
					{#each pathMappings as mapping, index (index)}
						<div class="flex items-center gap-2">
							<input
								type="text"
								class="input-bordered input flex-1 input-sm"
								placeholder={m.mediaBrowser_localPathPlaceholder()}
								value={mapping.localPath}
								onchange={(e) => updatePathMapping(index, 'localPath', e.currentTarget.value)}
							/>
							<span class="text-base-content/50">{m.mediaBrowser_to()}</span>
							<input
								type="text"
								class="input-bordered input flex-1 input-sm"
								placeholder={m.mediaBrowser_remotePathPlaceholder()}
								value={mapping.remotePath}
								onchange={(e) => updatePathMapping(index, 'remotePath', e.currentTarget.value)}
							/>
							<button
								type="button"
								class="btn btn-ghost text-error btn-sm"
								onclick={() => removePathMapping(index)}
								aria-label={m.action_remove()}
							>
								<Trash2 class="h-4 w-4" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Save Error -->
		{#if error}
			<div class="mt-6 alert alert-error">
				<XCircle class="h-5 w-5" />
				<div>
					<div class="font-medium">{m.mediaBrowser_failedToSave()}</div>
					<div class="text-sm opacity-80">{error}</div>
				</div>
			</div>
		{/if}

		<!-- Test Result -->
		<TestResult
			result={testResult}
			successDetails={testResult?.serverInfo
				? `${testResult.serverInfo.serverName} v${testResult.serverInfo.version}${
						testResult.serverInfo.detectedType
							? ` · ${getServerTypeName(testResult.serverInfo.detectedType)}`
							: ''
					}`
				: undefined}
		/>

		<!-- Actions -->
		<div class="modal-action">
			{#if mode === 'edit' && onDelete}
				<button class="btn mr-auto btn-outline btn-error" onclick={onDelete}
					>{m.action_delete()}</button
				>
			{/if}

			<button
				class="btn btn-ghost"
				onclick={handleTest}
				disabled={testing ||
					saving ||
					!host ||
					!name ||
					nameTooLong ||
					!serverType ||
					(mode === 'add' && !apiKey)}
			>
				{#if testing}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				{m.action_test()}
			</button>

			<button class="btn btn-ghost" onclick={onClose}>{m.action_cancel()}</button>

			<button
				class="btn btn-primary"
				onclick={handleSave}
				disabled={saving ||
					!host ||
					!name ||
					nameTooLong ||
					!serverType ||
					(mode === 'add' && !apiKey)}
			>
				{#if saving}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				{m.action_save()}
			</button>
		</div>
	{/if}
</ModalWrapper>
