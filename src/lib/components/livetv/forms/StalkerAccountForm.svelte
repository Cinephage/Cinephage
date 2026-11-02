<script lang="ts">
	import { CheckCircle2, XCircle } from '@lucide/svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import { ALL_LANGUAGE_OPTIONS } from '#lib/shared/languages.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		name: string;
		portalUrl: string;
		macAddress: string;
		epgUrl: string;
		enabled: boolean;
		language: string;
		mode: 'add' | 'edit';
		onNameChange: (value: string) => void;
		onPortalUrlChange: (value: string) => void;
		onMacAddressChange: (value: string) => void;
		onEpgUrlChange: (value: string) => void;
		onEnabledChange: (value: boolean) => void;
		onLanguageChange: (value: string) => void;
	}

	let {
		name,
		portalUrl,
		macAddress,
		epgUrl,
		enabled,
		language,
		mode: _mode,
		onNameChange,
		onPortalUrlChange,
		onMacAddressChange,
		onEpgUrlChange,
		onEnabledChange,
		onLanguageChange
	}: Props = $props();

	const macRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
	const isMacValid = $derived(macRegex.test(macAddress));
	const isUrlValid = $derived(() => {
		try {
			new URL(portalUrl);
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

	function formatMacAddress(value: string): string {
		const hex = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
		const parts = hex.match(/.{1,2}/g) || [];
		return parts.slice(0, 6).join(':');
	}

	function handleMacInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const cursorPos = input.selectionStart || 0;
		const oldLength = macAddress.length;

		onMacAddressChange(formatMacAddress(input.value));

		const newLength = macAddress.length;
		const diff = newLength - oldLength;
		requestAnimationFrame(() => {
			input.setSelectionRange(cursorPos + diff, cursorPos + diff);
		});
	}
</script>

<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
	<!-- Left Column: Connection -->
	<div class="space-y-4">
		<SectionHeader title={m.livetv_form_stalker_connection()} />

		<div class="form-control">
			<label class="label py-1" for="stalker-name">
				<span class="label-text">
					{m.livetv_form_stalker_nameLabel()}
					<span class="text-error">* </span>
				</span>
			</label>
			<input
				id="stalker-name"
				type="text"
				class="input-bordered input input-sm"
				value={name}
				oninput={(e) => onNameChange(e.currentTarget.value)}
				placeholder={m.livetv_form_stalker_myStalkerPortal()}
			/>
			<div class="label py-1">
				<span class="label-text-alt text-xs">{m.livetv_form_stalker_namePlaceholder()}</span>
			</div>
		</div>

		<div class="form-control">
			<label class="label py-1" for="portal-url">
				<span class="label-text">
					{m.livetv_form_stalker_portalUrlLabel()}
					<span class="text-error">* </span>
				</span>
			</label>
			<div class="relative">
				<input
					id="portal-url"
					type="url"
					class="input-bordered input w-full pr-8 input-sm"
					class:input-error={portalUrl.length > 0 && !isUrlValid()}
					value={portalUrl}
					oninput={(e) => onPortalUrlChange(e.currentTarget.value)}
					placeholder={m.livetv_form_stalker_portalUrlPlaceholder()}
				/>
				{#if portalUrl.length > 0}
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
				<span class="label-text-alt text-xs">{m.livetv_form_stalker_portalUrlHint()}</span>
			</div>
		</div>

		<div class="form-control">
			<label class="label py-1" for="mac-address">
				<span class="label-text">
					{m.livetv_form_stalker_macAddressLabel()}
					<span class="text-error">* </span>
				</span>
			</label>
			<div class="relative">
				<input
					id="mac-address"
					type="text"
					class="input-bordered input w-full pr-8 font-mono input-sm"
					class:input-error={macAddress.length > 0 && !isMacValid}
					value={macAddress}
					oninput={handleMacInput}
					placeholder={m.livetv_form_stalker_macAddressPlaceholder()}
					maxlength="17"
				/>
				{#if macAddress.length > 0}
					<div class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
						{#if isMacValid}
							<CheckCircle2 class="h-4 w-4 text-success" />
						{:else}
							<XCircle class="h-4 w-4 text-error" />
						{/if}
					</div>
				{/if}
			</div>
			<div class="label py-1">
				<span class="label-text-alt text-xs">{m.livetv_form_stalker_macAddressHint()}</span>
			</div>
		</div>
	</div>

	<!-- Right Column: Settings -->
	<div class="space-y-4">
		<SectionHeader title={m.livetv_form_stalker_settings()} />

		<div class="form-control">
			<label class="label py-1" for="epg-url">
				<span class="label-text">{m.livetv_form_stalker_epgUrlLabel()}</span>
			</label>
			<div class="relative">
				<input
					id="epg-url"
					type="url"
					class="input-bordered input w-full pr-8 input-sm"
					class:input-error={epgUrl.length > 0 && !isEpgUrlValid()}
					value={epgUrl}
					oninput={(e) => onEpgUrlChange(e.currentTarget.value)}
					placeholder={m.livetv_form_stalker_epgUrlPlaceholder()}
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
				<span class="label-text-alt text-xs">{m.livetv_form_stalker_epgUrlHint()}</span>
			</div>
		</div>

		<div class="form-control">
			<label class="label py-1" for="stalker-language">
				<span class="label-text">{m.livetv_form_stalker_languageLabel()}</span>
			</label>
			<select
				id="stalker-language"
				class="select-bordered select w-full select-sm"
				value={language}
				onchange={(e) => onLanguageChange(e.currentTarget.value)}
			>
				{#each ALL_LANGUAGE_OPTIONS as option (option.code)}
					<option value={option.code}>{option.name}</option>
				{/each}
			</select>
			<div class="label py-1">
				<span class="label-text-alt text-xs">{m.livetv_form_stalker_languageHint()}</span>
			</div>
		</div>

		<label class="label cursor-pointer gap-2">
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={enabled}
				onchange={(e) => onEnabledChange(e.currentTarget.checked)}
			/>
			<span class="label-text">{m.livetv_form_stalker_enabled()}</span>
		</label>
	</div>
</div>
