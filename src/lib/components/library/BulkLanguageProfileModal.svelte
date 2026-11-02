<script lang="ts">
	/**
	 * Bulk language profile assignment modal.
	 *
	 * Wraps POST /api/subtitles/language-profiles/bulk-assign: assign a
	 * language profile (or reset to inherit), optionally toggle the
	 * wants-subtitles gate, and optionally clear per-item subtitle
	 * requirement overrides so items follow the chosen profile again.
	 */
	import { Loader2 } from '@lucide/svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLanguageProfiles } from '#lib/api/subtitles.js';

	interface Props {
		open: boolean;
		mediaType: 'movie' | 'series';
		selectedIds: string[];
		/** Optional pre-loaded profiles; fetched when omitted. */
		languageProfiles?: Array<{ id: string; name: string }>;
		onClose: () => void;
		onApplied?: (updated: number) => void;
	}

	let { open, mediaType, selectedIds, languageProfiles, onClose, onApplied }: Props = $props();

	let selectedProfileId = $state('');
	let profiles = $state<Array<{ id: string; name: string }>>([]);
	let wantsSubtitles: boolean | null = $state(null);
	let clearOverrides = $state(false);
	let applying = $state(false);
	let error = $state<string | null>(null);

	// Self-contained: load profiles on first open when not provided.
	$effect(() => {
		if (open && profiles.length === 0 && (!languageProfiles || languageProfiles.length === 0)) {
			getLanguageProfiles()
				.then((result) => {
					profiles = (result as unknown as Array<{ id: string; name: string }>) ?? [];
				})
				.catch(() => undefined);
		}
	});

	async function apply() {
		if (applying || selectedIds.length === 0) return;
		applying = true;
		error = null;
		try {
			const response = await fetch('/api/subtitles/language-profiles/bulk-assign', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mediaType,
					mediaIds: selectedIds,
					languageProfileId: selectedProfileId || null,
					wantsSubtitles: wantsSubtitles ?? undefined,
					clearOverrides
				})
			});
			const body = (await response.json().catch(() => ({}))) as {
				success?: boolean;
				updated?: number;
				error?: string;
			};
			if (!response.ok || !body.success) {
				throw new Error(body.error ?? 'Bulk assignment failed');
			}
			onApplied?.(body.updated ?? selectedIds.length);
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			applying = false;
		}
	}
</script>

{#if open}
	<div class="modal modal-open">
		<div class="modal-box max-w-md">
			<h3 class="text-lg font-bold">{m.library_subtitleProfile_label()}</h3>
			<p class="mt-1 text-sm text-base-content/60">
				{selectedIds.length}
				{mediaType === 'movie' ? 'movies' : 'series'} selected
			</p>

			<div class="mt-4 flex flex-col gap-3">
				<div class="form-control">
					<label class="label py-1" for="bulk-language-profile">
						<span class="label-text text-sm">{m.library_subtitleProfile_label()}</span>
					</label>
					<select
						id="bulk-language-profile"
						class="select-bordered select w-full select-sm"
						bind:value={selectedProfileId}
					>
						<option value="">{m.library_subtitleProfile_inherit()}</option>
						{#each languageProfiles ?? profiles as profile (profile.id)}
							<option value={profile.id}>{profile.name}</option>
						{/each}
					</select>
				</div>

				<div class="form-control">
					<label class="label py-1" for="bulk-wants-subtitles">
						<span class="label-text text-sm">{m.library_add_autoDownloadSubtitles()}</span>
					</label>
					<select
						id="bulk-wants-subtitles"
						class="select-bordered select w-full select-sm"
						bind:value={wantsSubtitles}
					>
						<option value={null}>No change</option>
						<option value={true}>On</option>
						<option value={false}>Off</option>
					</select>
				</div>

				<label class="flex cursor-pointer items-center gap-2">
					<input type="checkbox" class="checkbox checkbox-sm" bind:checked={clearOverrides} />
					<span class="text-sm">Clear custom subtitle choices (reset to the profile)</span>
				</label>

				{#if error}
					<p class="text-sm text-error">{error}</p>
				{/if}
			</div>

			<div class="modal-action">
				<button class="btn btn-ghost btn-sm" onclick={onClose} disabled={applying}>
					{m.action_cancel()}
				</button>
				<button class="btn btn-primary btn-sm" onclick={apply} disabled={applying}>
					{#if applying}
						<Loader2 size={14} class="animate-spin" />
					{/if}
					{m.action_save()}
				</button>
			</div>
		</div>
		<button class="modal-backdrop cursor-default" aria-label="Close" onclick={onClose}></button>
	</div>
{/if}
