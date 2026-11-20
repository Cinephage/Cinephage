<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ArrowDown, ArrowUp, Plus, Star, Trash2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper, ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { MusicProfileView } from './music-profiles.js';

	interface Props {
		profiles: MusicProfileView[];
		defaultId: string | null;
	}

	let { profiles, defaultId }: Props = $props();

	type TierDraft = {
		kind: 'lossless' | 'lossy' | 'streaming';
		label: string;
		formats: string;
		minBitrateKbps: string;
	};

	let modalOpen = $state(false);
	let editingId = $state<string | null>(null);
	let name = $state('');
	let description = $state('');
	let allowFallback = $state(true);
	let tiers = $state<TierDraft[]>([]);
	let saving = $state(false);
	let deleteTarget = $state<MusicProfileView | null>(null);
	let deleting = $state(false);

	function blankTier(kind: TierDraft['kind'] = 'lossless'): TierDraft {
		return { kind, label: '', formats: '', minBitrateKbps: '' };
	}

	function openNew() {
		editingId = null;
		name = '';
		description = '';
		allowFallback = true;
		tiers = [blankTier('lossless')];
		modalOpen = true;
	}

	function openEdit(profile: MusicProfileView) {
		editingId = profile.id;
		name = profile.name;
		description = profile.description ?? '';
		allowFallback = profile.allowFallback;
		tiers = profile.tiers.map((tier) => ({
			kind: tier.kind,
			label: tier.label,
			formats: (tier.formats ?? []).join(', '),
			minBitrateKbps: tier.minBitrateKbps ? String(tier.minBitrateKbps) : ''
		}));
		modalOpen = true;
	}

	function addTier() {
		tiers = [...tiers, blankTier('lossy')];
	}

	function removeTier(index: number) {
		tiers = tiers.filter((_, i) => i !== index);
	}

	function moveTier(index: number, direction: -1 | 1) {
		const next = [...tiers];
		const target = index + direction;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		tiers = next;
	}

	function tierPayload() {
		return tiers.map((tier) => ({
			kind: tier.kind,
			label: tier.label.trim(),
			...(tier.kind !== 'streaming' && tier.formats.trim()
				? {
						formats: tier.formats
							.split(',')
							.map((format) => format.trim().toLowerCase())
							.filter(Boolean)
					}
				: {}),
			...(tier.kind === 'lossy' && tier.minBitrateKbps.trim()
				? { minBitrateKbps: Number.parseInt(tier.minBitrateKbps, 10) }
				: {})
		}));
	}

	async function save() {
		if (saving) return;
		saving = true;
		try {
			// One profile store: music rows are scoring_profiles rows tagged as music.
			const payload = editingId
				? {
						id: editingId,
						name: name.trim(),
						description: description.trim() || null,
						upgradesAllowed: allowFallback,
						musicTiers: tierPayload(),
						mediaKind: 'music'
					}
				: {
						name: name.trim(),
						description: description.trim() || null,
						upgradesAllowed: allowFallback,
						musicTiers: tierPayload(),
						mediaKind: 'music'
					};
			const response = await fetch('/api/scoring-profiles', {
				method: editingId ? 'PUT' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			modalOpen = false;
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			saving = false;
		}
	}

	async function setDefault(profile: MusicProfileView) {
		const response = await fetch('/api/music/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ defaultProfileId: profile.id })
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			toasts.error(body.error ?? m.common_failedToSave());
			return;
		}
		await invalidateAll();
	}

	async function confirmDelete() {
		if (!deleteTarget || deleting) return;
		deleting = true;
		try {
			const response = await fetch('/api/scoring-profiles', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: deleteTarget.id })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				toasts.error(body.error ?? m.common_failedToSave());
				return;
			}
			deleteTarget = null;
			await invalidateAll();
		} finally {
			deleting = false;
		}
	}

	function tierSummary(profile: MusicProfileView): string {
		return profile.tiers
			.map((tier) => {
				if (tier.kind === 'streaming') return tier.label;
				const parts = [tier.label];
				if (tier.formats?.length) parts.push(tier.formats.join('/').toUpperCase());
				if (tier.minBitrateKbps) parts.push(`${tier.minBitrateKbps}k`);
				return parts.join(' · ');
			})
			.join('  →  ');
	}

	const canSave = $derived(
		name.trim().length > 0 &&
			tiers.length > 0 &&
			tiers.every(
				(tier) =>
					tier.label.trim().length > 0 &&
					(tier.kind !== 'lossy' ||
						!tier.minBitrateKbps.trim() ||
						Number.isInteger(Number.parseInt(tier.minBitrateKbps, 10)))
			)
	);
</script>

<section class="space-y-4">
	<div>
		<h2 class="text-lg font-semibold">{m.music_profilesTitle()}</h2>
		<p class="mt-1 max-w-3xl text-sm text-base-content/60">
			{m.music_profilesDescription()}
		</p>
	</div>

	<div class="grid gap-3 lg:grid-cols-2">
		{#each profiles as profile (profile.id)}
			<div class="rounded-xl bg-base-200 p-4">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<div class="flex flex-wrap items-center gap-2">
							<h3 class="font-semibold">{profile.name}</h3>
							{#if profile.id === defaultId}
								<span class="badge badge-primary badge-sm">{m.music_profileDefaultBadge()}</span>
							{/if}
							{#if profile.isBuiltIn}
								<span class="badge badge-ghost badge-sm">{m.common_builtIn()}</span>
							{/if}
						</div>
						{#if profile.description}
							<p class="mt-1 text-sm text-base-content/60">{profile.description}</p>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-1">
						{#if profile.id !== defaultId}
							<button
								class="btn btn-ghost btn-xs btn-square"
								title={m.music_profileSetDefault()}
								aria-label={m.music_profileSetDefault()}
								onclick={() => setDefault(profile)}
							>
								<Star class="h-3.5 w-3.5" />
							</button>
						{/if}
						<button class="btn btn-ghost btn-xs" onclick={() => openEdit(profile)}>
							{m.action_edit()}
						</button>
						{#if !profile.isBuiltIn}
							<button
								class="btn btn-ghost btn-xs btn-square text-error"
								title={m.common_delete()}
								aria-label={m.common_delete()}
								onclick={() => (deleteTarget = profile)}
							>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</div>
				<div class="mt-3 flex flex-wrap gap-1.5">
					{#each profile.tiers as tier, index (index)}
						<span class="badge badge-ghost badge-sm">
							{index + 1}. {tier.label}
							{#if tier.kind === 'streaming'}
								· {m.music_tierStreaming()}
							{:else if tier.formats?.length}
								· {tier.formats.join('/').toUpperCase()}
							{/if}
						</span>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	<button class="btn gap-1.5 btn-primary btn-sm" onclick={openNew}>
		<Plus class="h-4 w-4" />
		{m.music_addProfile()}
	</button>
</section>

<ModalWrapper open={modalOpen} onClose={() => (modalOpen = false)} maxWidth="2xl" labelledBy="music-profile-title">
	<div class="border-b border-base-300 px-6 py-4">
		<h3 id="music-profile-title" class="text-lg font-semibold">
			{editingId ? m.music_editProfile() : m.music_addProfile()}
		</h3>
	</div>

	<div class="space-y-4 px-6 py-5">
		<div class="grid gap-4 sm:grid-cols-2">
			<label class="form-control">
				<span class="mb-1 text-sm font-medium">{m.music_profileName()}</span>
				<input class="input w-full input-bordered" bind:value={name} disabled={saving} />
			</label>
			<label class="form-control">
				<span class="mb-1 text-sm font-medium">{m.music_profileDescription()}</span>
				<input class="input w-full input-bordered" bind:value={description} disabled={saving} />
			</label>
		</div>

		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" class="checkbox checkbox-sm" bind:checked={allowFallback} disabled={saving} />
			{m.music_allowFallback()}
		</label>

		<div>
			<span class="mb-2 block text-sm font-medium">{m.music_profileTiers()}</span>
			<div class="space-y-2">
				{#each tiers as tier, index (index)}
					<div class="flex flex-wrap items-end gap-2 rounded-lg bg-base-200 p-2">
						<label class="form-control w-28">
							<span class="mb-1 text-xs text-base-content/60">{m.music_tierKind()}</span>
							<select class="select w-full select-bordered select-xs" bind:value={tier.kind} disabled={saving}>
								<option value="lossless">{m.music_tierLossless()}</option>
								<option value="lossy">{m.music_tierLossy()}</option>
								<option value="streaming">{m.music_tierStreaming()}</option>
							</select>
						</label>
						<label class="form-control min-w-32 flex-1">
							<span class="mb-1 text-xs text-base-content/60">{m.music_tierLabel()}</span>
							<input class="input w-full input-bordered input-xs" bind:value={tier.label} disabled={saving} />
						</label>
						{#if tier.kind !== 'streaming'}
							<label class="form-control w-40">
								<span class="mb-1 text-xs text-base-content/60">{m.music_tierFormats()}</span>
								<input
									class="input w-full input-bordered input-xs"
									bind:value={tier.formats}
									placeholder="flac, mp3"
									disabled={saving}
								/>
							</label>
						{/if}
						{#if tier.kind === 'lossy'}
							<label class="form-control w-24">
								<span class="mb-1 text-xs text-base-content/60">{m.music_tierMinBitrate()}</span>
								<input
									class="input w-full input-bordered input-xs"
									bind:value={tier.minBitrateKbps}
									inputmode="numeric"
									placeholder="256"
									disabled={saving}
								/>
							</label>
						{/if}
						<div class="flex items-center gap-0.5">
							<button class="btn btn-ghost btn-xs btn-square" disabled={index === 0} onclick={() => moveTier(index, -1)} aria-label="Up">
								<ArrowUp class="h-3.5 w-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-xs btn-square"
								disabled={index === tiers.length - 1}
								onclick={() => moveTier(index, 1)}
								aria-label="Down"
							>
								<ArrowDown class="h-3.5 w-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-xs btn-square text-error"
								disabled={tiers.length === 1}
								onclick={() => removeTier(index)}
								aria-label={m.common_delete()}
							>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				{/each}
			</div>
			<button class="btn mt-2 gap-1 btn-ghost btn-xs" onclick={addTier}>
				<Plus class="h-3.5 w-3.5" />
				{m.music_addTier()}
			</button>
		</div>
	</div>

	<div class="flex justify-end gap-2 border-t border-base-300 px-6 py-4">
		<button class="btn btn-ghost btn-sm" onclick={() => (modalOpen = false)} disabled={saving}>
			{m.action_cancel()}
		</button>
		<button class="btn btn-primary btn-sm" onclick={save} disabled={!canSave || saving}>
			{saving ? m.common_saving() : m.action_save()}
		</button>
	</div>
</ModalWrapper>

<ConfirmationModal
	open={deleteTarget !== null}
	title={m.music_deleteProfileTitle()}
	message={m.music_deleteProfileMessage({ name: deleteTarget?.name ?? '' })}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={deleting}
	onConfirm={confirmDelete}
	onCancel={() => (deleteTarget = null)}
/>
