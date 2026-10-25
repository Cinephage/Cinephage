<script lang="ts">
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		name: string;
		apiToken: string;
		priority: number;
		enabled: boolean;
		removeAfterImport: boolean;
		mode: 'add' | 'edit';
		hasApiToken: boolean;
		selectedDefinitionName: string;
		maxNameLength: number;
		nameTooLong: boolean;
		/** Show the client-selection priority field (only when a second debrid client exists). */
		showPriority: boolean;
		allowMovies: boolean;
		allowTv: boolean;
	}

	let {
		name = $bindable(),
		apiToken = $bindable(),
		priority = $bindable(),
		enabled = $bindable(),
		removeAfterImport = $bindable(),
		mode,
		hasApiToken,
		selectedDefinitionName = '',
		maxNameLength,
		nameTooLong,
		showPriority,
		allowMovies = $bindable(),
		allowTv = $bindable()
	}: Props = $props();
</script>

<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
	<div class="space-y-4">
		<SectionHeader title={m.connection_section_title()} />

		<div class="form-control">
			<label class="label py-1" for="debrid-name">
				<span class="label-text">
					{m.common_name()}
					<span class="text-error">* </span>
				</span>
			</label>
			<input
				id="debrid-name"
				type="text"
				class="input-bordered input input-sm"
				bind:value={name}
				maxlength={maxNameLength}
				placeholder={selectedDefinitionName || 'My Download Client'}
			/>
			<div class="label py-1">
				<span class="label-text-alt text-xs {nameTooLong ? 'text-error' : 'text-base-content/60'}">
					{name.length}/{maxNameLength}
				</span>
				{#if nameTooLong}
					<span class="label-text-alt text-xs text-error"
						>{m.validation_maxChars({ max: maxNameLength })}</span
					>
				{/if}
			</div>
		</div>

		<div class="form-control">
			<label class="label py-1" for="debrid-api-token">
				<span class="label-text">
					{m.downloadClient_apiToken()}
					{#if mode === 'add' || !hasApiToken}
						<span class="text-error">* </span>
					{/if}
					{#if mode === 'edit' && hasApiToken}
						<span class="text-xs opacity-50">({m.auth_blankToKeep()})</span>
					{/if}
				</span>
			</label>
			<input
				id="debrid-api-token"
				type="password"
				class="input-bordered input input-sm"
				bind:value={apiToken}
				placeholder={mode === 'edit' && hasApiToken ? '********' : ''}
			/>
			<div class="label py-1">
				<span class="label-text-alt text-xs">{m.downloadClient_apiTokenHelp()}</span>
			</div>
		</div>
	</div>

	<div class="space-y-4">
		<SectionHeader title={m.common_settings()} />

		{#if showPriority}
			<div class="form-control">
				<label class="label py-1" for="debrid-priority">
					<span class="label-text">{m.downloadClient_debridPriorityLabel()}</span>
				</label>
				<input
					id="debrid-priority"
					type="number"
					class="input-bordered input input-sm"
					bind:value={priority}
					min="1"
					max="99"
				/>
				<div class="label py-1">
					<span class="label-text-alt text-xs whitespace-normal"
						>{m.downloadClient_priorityHelp()}</span
					>
				</div>
			</div>
		{/if}

		<div class="form-control">
			<span class="label-text py-1">{m.common_categories()}</span>
			<div class="flex flex-wrap gap-x-4 gap-y-1">
				<label class="label cursor-pointer gap-2">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						bind:checked={allowMovies}
					/>
					<span class="label-text">{m.common_movies()}</span>
				</label>
				<label class="label cursor-pointer gap-2">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						bind:checked={allowTv}
					/>
					<span class="label-text">{m.common_tvShows()}</span>
				</label>
			</div>
			<div class="label py-1">
				<span class="label-text-alt text-xs whitespace-normal"
					>{m.downloadClient_contentTypesHelp()}</span
				>
			</div>
		</div>

		<div class="flex flex-col gap-2">
			<label class="label cursor-pointer gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm checkbox-primary"
					bind:checked={enabled}
				/>
				<span class="label-text">{m.common_enabled()}</span>
			</label>

			<label class="label cursor-pointer gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm checkbox-primary"
					bind:checked={removeAfterImport}
				/>
				<span class="label-text">{m.downloadClient_removeAfterImport()}</span>
			</label>
		</div>
	</div>
</div>
