<script lang="ts">
	import { X, ShieldAlert } from '@lucide/svelte';
	import { updateBlockedExtensions } from '#lib/api/settings.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';

	let { data } = $props();

	let extensions = $state<string[]>([]);
	let inputValue = $state('');
	let saving = $state(false);

	$effect(() => {
		extensions = [...data.extensions];
	});

	function normalizeExt(raw: string): string {
		const trimmed = raw.trim().toLowerCase();
		return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
	}

	function addExtension() {
		if (!inputValue.trim()) return;
		const ext = normalizeExt(inputValue);
		if (ext.length < 2 || ext.length > 10) {
			toasts.error('Extension must be between 1 and 9 characters');
			return;
		}
		if (!extensions.includes(ext)) {
			extensions = [...extensions, ext];
		}
		inputValue = '';
	}

	function removeExtension(ext: string) {
		extensions = extensions.filter((e) => e !== ext);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addExtension();
		}
	}

	async function handleSave() {
		saving = true;
		try {
			await updateBlockedExtensions({ extensions });
			toasts.success('Blocked video extensions saved');
		} catch {
			toasts.error('Failed to save blocked video extensions');
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{m.nav_blockedExtensions()}</title>
</svelte:head>

<SettingsPage
	title="Blocked Video Extensions"
	subtitle="Video file extensions listed here will be skipped during library scans globally. A root folder's own blocked extension list takes priority over this global setting."
>
	{#snippet actions()}
		<button class="btn btn-primary btn-sm" onclick={handleSave} disabled={saving}>
			{saving ? 'Saving...' : 'Save'}
		</button>
	{/snippet}

	<div class="alert alert-warning">
		<ShieldAlert class="h-5 w-5 shrink-0" />
		<div>
			<p class="font-medium">Dangerous & executable extensions are always blocked</p>
			<p class="text-sm opacity-80">
				Releases containing <span class="font-mono"
					>.exe .bat .cmd .sh .vbs .ps1 .scr .lnk .arj .lzh .zipx</span
				> are permanently excluded from search results regardless of this setting.
			</p>
		</div>
	</div>

	<div class="card border border-base-300 bg-base-200">
		<div class="card-body gap-4">
			<div>
				<h2 class="card-title text-base">Global Blocked Video Extensions</h2>
				<p class="mt-0.5 text-sm text-base-content/60">
					Add extensions like <span class="font-mono">.avi</span> or
					<span class="font-mono">.ts</span> to skip those file types in all root folders that don't have
					their own override.
				</p>
			</div>

			{#if extensions.length > 0}
				<div class="flex flex-wrap gap-2">
					{#each extensions as ext (ext)}
						<span class="badge gap-1.5 badge-outline font-mono text-sm">
							{ext}
							<button
								onclick={() => removeExtension(ext)}
								aria-label="Remove {ext}"
								class="hover:text-error"
							>
								<X class="h-3 w-3" />
							</button>
						</span>
					{/each}
				</div>
			{:else}
				<p class="text-sm text-base-content/40 italic">No extensions blocked globally.</p>
			{/if}

			<div class="flex gap-2">
				<input
					type="text"
					bind:value={inputValue}
					onkeydown={handleKeydown}
					placeholder=".avi"
					class="input-bordered input w-32 font-mono input-sm"
					maxlength="10"
				/>
				<button class="btn btn-outline btn-sm" onclick={addExtension} disabled={!inputValue.trim()}>
					Add
				</button>
			</div>
		</div>
	</div>
</SettingsPage>
