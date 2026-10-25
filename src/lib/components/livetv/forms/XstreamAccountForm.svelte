<script lang="ts">
	import { CheckCircle2, XCircle } from '@lucide/svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		name: string;
		baseUrl: string;
		username: string;
		password: string;
		epgUrl: string;
		enabled: boolean;
		mode: 'add' | 'edit';
		hasPassword: boolean;
		onNameChange: (value: string) => void;
		onBaseUrlChange: (value: string) => void;
		onUsernameChange: (value: string) => void;
		onPasswordChange: (value: string) => void;
		onEpgUrlChange: (value: string) => void;
		onEnabledChange: (value: boolean) => void;
	}

	let {
		name,
		baseUrl,
		username,
		password,
		epgUrl,
		enabled,
		mode,
		hasPassword,
		onNameChange,
		onBaseUrlChange,
		onUsernameChange,
		onPasswordChange,
		onEpgUrlChange,
		onEnabledChange
	}: Props = $props();

	const isUrlValid = $derived(() => {
		try {
			new URL(baseUrl);
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
</script>

<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
	<!-- Left Column: Connection -->
	<div class="space-y-4">
		<SectionHeader title={m.livetv_form_xstream_connection()} />

		<div class="form-control">
			<label class="label py-1" for="xstream-name">
				<span class="label-text">
					{m.livetv_form_xstream_nameLabel()}
					<span class="text-error">* </span>
				</span>
			</label>
			<input
				id="xstream-name"
				type="text"
				class="input-bordered input input-sm"
				value={name}
				oninput={(e) => onNameChange(e.currentTarget.value)}
				placeholder={m.livetv_form_xstream_myXstreamAccount()}
			/>
			<div class="label py-1">
				<span class="label-text-alt text-xs">{m.livetv_form_xstream_namePlaceholder()}</span>
			</div>
		</div>

		<div class="form-control">
			<label class="label py-1" for="base-url">
				<span class="label-text">
					{m.livetv_form_xstream_serverUrlLabel()}
					<span class="text-error">* </span>
				</span>
			</label>
			<div class="relative">
				<input
					id="base-url"
					type="url"
					class="input-bordered input w-full pr-8 input-sm"
					class:input-error={baseUrl.length > 0 && !isUrlValid()}
					value={baseUrl}
					oninput={(e) => onBaseUrlChange(e.currentTarget.value)}
					placeholder={m.livetv_form_xstream_serverUrlPlaceholder()}
				/>
				{#if baseUrl.length > 0}
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
				<span class="label-text-alt text-xs">{m.livetv_form_xstream_serverUrlHint()}</span>
			</div>
		</div>

		<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
			<div class="form-control">
				<label class="label py-1" for="username">
					<span class="label-text">
						{m.livetv_form_xstream_usernameLabel()}
						<span class="text-error">* </span>
					</span>
				</label>
				<input
					id="username"
					type="text"
					class="input-bordered input input-sm"
					value={username}
					oninput={(e) => onUsernameChange(e.currentTarget.value)}
					placeholder={m.livetv_form_xstream_usernamePlaceholder()}
				/>
			</div>

			<div class="form-control">
				<label class="label py-1" for="password">
					<span class="label-text">
						{m.livetv_form_xstream_passwordLabel()}
						{#if mode === 'add' || !hasPassword}
							<span class="text-error">* </span>
						{/if}
						{#if mode === 'edit' && hasPassword}
							<span class="text-xs opacity-50">({m.auth_blankToKeep()})</span>
						{/if}
					</span>
				</label>
				<input
					id="password"
					type="password"
					class="input-bordered input input-sm"
					value={password}
					oninput={(e) => onPasswordChange(e.currentTarget.value)}
					placeholder={mode === 'edit' && hasPassword ? '********' : '••••••••'}
				/>
			</div>
		</div>
	</div>

	<!-- Right Column: Settings -->
	<div class="space-y-4">
		<SectionHeader title={m.livetv_form_xstream_settings()} />

		<div class="form-control">
			<label class="label py-1" for="epg-url">
				<span class="label-text">{m.livetv_form_xstream_epgUrlLabel()}</span>
			</label>
			<div class="relative">
				<input
					id="epg-url"
					type="url"
					class="input-bordered input w-full pr-8 input-sm"
					class:input-error={epgUrl.length > 0 && !isEpgUrlValid()}
					value={epgUrl}
					oninput={(e) => onEpgUrlChange(e.currentTarget.value)}
					placeholder={m.livetv_form_xstream_epgUrlPlaceholder()}
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
				<span class="label-text-alt block text-xs wrap-break-word whitespace-normal"
					>{m.livetv_form_xstream_epgUrlHint()}</span
				>
			</div>
		</div>

		<label class="label cursor-pointer gap-2">
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={enabled}
				onchange={(e) => onEnabledChange(e.currentTarget.checked)}
			/>
			<span class="label-text">{m.livetv_form_xstream_enabled()}</span>
		</label>
	</div>
</div>
