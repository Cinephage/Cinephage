<script lang="ts">
	import { CheckCircle2, XCircle, Link, FileText } from '@lucide/svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		name: string;
		inputMode: 'url' | 'file';
		url: string;
		fileContent: string;
		fileName: string;
		epgUrl: string;
		autoRefresh: boolean;
		enabled: boolean;
		mode: 'add' | 'edit';
		onNameChange: (value: string) => void;
		onInputModeChange: (mode: 'url' | 'file') => void;
		onUrlChange: (value: string) => void;
		onFileUpload: (content: string, name: string) => void;
		onEpgUrlChange: (value: string) => void;
		onAutoRefreshChange: (value: boolean) => void;
		onEnabledChange: (value: boolean) => void;
	}

	let {
		name,
		inputMode,
		url,
		fileContent: _fileContent,
		fileName,
		epgUrl,
		autoRefresh,
		enabled,
		mode,
		onNameChange,
		onInputModeChange,
		onUrlChange,
		onFileUpload,
		onEpgUrlChange,
		onAutoRefreshChange,
		onEnabledChange
	}: Props = $props();

	const isUrlValid = $derived(() => {
		if (inputMode !== 'url') return true;
		if (!url.trim()) return false;
		try {
			new URL(url);
			return true;
		} catch {
			return false;
		}
	});
	const isEpgUrlValid = $derived(() => {
		if (!epgUrl.trim()) return true;
		try {
			new URL(epgUrl);
			return true;
		} catch {
			return false;
		}
	});

	function handleFileUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (file) {
			const reader = new FileReader();
			reader.onload = (e) => {
				onFileUpload(e.target?.result as string, file.name);
			};
			reader.readAsText(file);
		}
	}
</script>

<div class="space-y-4">
	<!-- Name (full width) -->
	<div class="form-control">
		<label class="label py-1" for="m3u-name">
			<span class="label-text">
				{m.livetv_form_m3u_nameLabel()}
				<span class="text-error">* </span>
			</span>
		</label>
		<input
			id="m3u-name"
			type="text"
			class="input-bordered input input-sm"
			value={name}
			oninput={(e) => onNameChange(e.currentTarget.value)}
			placeholder={m.livetv_form_m3u_m3uPlaylistPlaceholder()}
		/>
		<div class="label py-1">
			<span class="label-text-alt text-xs">{m.livetv_form_m3u_namePlaceholder()}</span>
		</div>
	</div>

	<!-- Input Mode Tabs (only when adding) -->
	{#if mode === 'add'}
		<div class="tabs-boxed tabs">
			<button
				class="tab {inputMode === 'url' ? 'tab-active' : ''}"
				onclick={() => onInputModeChange('url')}
			>
				<Link class="mr-2 inline h-4 w-4" />
				{m.livetv_form_m3u_urlTab()}
			</button>
			<button
				class="tab {inputMode === 'file' ? 'tab-active' : ''}"
				onclick={() => onInputModeChange('file')}
			>
				<FileText class="mr-2 inline h-4 w-4" />
				{m.livetv_form_m3u_fileTab()}
			</button>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
		<!-- Left Column: Source -->
		<div class="space-y-4">
			<SectionHeader title={m.livetv_form_m3u_playlistSource()} />

			{#if inputMode === 'url'}
				<div class="form-control">
					<label class="label py-1" for="m3u-url">
						<span class="label-text">
							{m.livetv_form_m3u_m3uUrlLabel()}
							<span class="text-error">* </span>
						</span>
					</label>
					<div class="relative">
						<input
							id="m3u-url"
							type="url"
							class="input-bordered input w-full pr-8 input-sm"
							class:input-error={url.length > 0 && !isUrlValid()}
							value={url}
							oninput={(e) => onUrlChange(e.currentTarget.value)}
							placeholder={m.livetv_form_m3u_m3uUrlPlaceholder()}
						/>
						{#if url.length > 0}
							<div class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
								{#if isUrlValid()}
									<CheckCircle2 class="h-4 w-4 text-success" />
								{:else}
									<XCircle class="h-4 w-4 text-error" />
								{/if}
							</div>
						{/if}
					</div>
					<div class="label py-1">
						<span class="label-text-alt text-xs">{m.livetv_form_m3u_m3uUrlHint()}</span>
					</div>
				</div>
			{:else if inputMode === 'file'}
				<div class="form-control">
					<label class="label py-1" for="m3u-file">
						<span class="label-text">
							{m.livetv_form_m3u_uploadFileLabel()}
							<span class="text-error">* </span>
						</span>
					</label>
					<input
						id="m3u-file"
						type="file"
						accept=".m3u,.m3u8"
						class="file-input-bordered file-input flex-1 file-input-sm"
						onchange={handleFileUpload}
					/>
					{#if fileName}
						<div class="label py-1">
							<span class="label-text-alt text-xs text-success"
								>{m.livetv_form_m3u_fileLoaded({ name: fileName })}</span
							>
						</div>
					{:else}
						<div class="label py-1">
							<span class="label-text-alt text-xs">{m.livetv_form_m3u_fileHint()}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Right Column: Settings -->
		<div class="space-y-4">
			<SectionHeader title={m.livetv_form_m3u_settings()} />

			{#if inputMode === 'url'}
				<div class="form-control">
					<label class="label py-1" for="epg-url">
						<span class="label-text">{m.livetv_form_m3u_epgUrlLabel()}</span>
					</label>
					<div class="relative">
						<input
							id="epg-url"
							type="url"
							class="input-bordered input w-full pr-8 input-sm"
							class:input-error={epgUrl.length > 0 && !isEpgUrlValid()}
							value={epgUrl}
							oninput={(e) => onEpgUrlChange(e.currentTarget.value)}
							placeholder={m.livetv_form_m3u_epgUrlPlaceholder()}
						/>
						{#if epgUrl.length > 0}
							<div class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
								{#if isEpgUrlValid()}
									<CheckCircle2 class="h-4 w-4 text-success" />
								{:else}
									<XCircle class="h-4 w-4 text-error" />
								{/if}
							</div>
						{/if}
					</div>
					<div class="label py-1">
						<span class="label-text-alt text-xs">{m.livetv_form_m3u_epgUrlHint()}</span>
					</div>
				</div>

				<label class="label cursor-pointer gap-2">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={autoRefresh}
						onchange={(e) => onAutoRefreshChange(e.currentTarget.checked)}
					/>
					<span class="label-text">{m.livetv_form_m3u_autoRefresh()}</span>
				</label>
			{:else if inputMode === 'file'}
				<div class="form-control">
					<label class="label py-1" for="epg-url">
						<span class="label-text">{m.livetv_form_m3u_epgUrlLabel()}</span>
					</label>
					<div class="relative">
						<input
							id="epg-url"
							type="url"
							class="input-bordered input w-full pr-8 input-sm"
							class:input-error={epgUrl.length > 0 && !isEpgUrlValid()}
							value={epgUrl}
							oninput={(e) => onEpgUrlChange(e.currentTarget.value)}
							placeholder={m.livetv_form_m3u_epgUrlPlaceholder()}
						/>
						{#if epgUrl.length > 0}
							<div class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
								{#if isEpgUrlValid()}
									<CheckCircle2 class="h-4 w-4 text-success" />
								{:else}
									<XCircle class="h-4 w-4 text-error" />
								{/if}
							</div>
						{/if}
					</div>
					<div class="label py-1">
						<span class="label-text-alt text-xs">{m.livetv_form_m3u_epgUrlHint()}</span>
					</div>
				</div>
			{/if}

			<label class="label cursor-pointer gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm checkbox-primary"
					checked={enabled}
					onchange={(e) => onEnabledChange(e.currentTarget.checked)}
				/>
				<span class="label-text">{m.livetv_form_m3u_enabled()}</span>
			</label>
		</div>
	</div>
</div>
