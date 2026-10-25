<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { refreshAll } from '$app/navigation';
	import { Clock, Plus, Pencil, Trash2 } from '@lucide/svelte';
	import {
		ModalWrapper,
		ModalHeader,
		ModalFooter,
		ConfirmationModal
	} from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import {
		createDelayProfile,
		updateDelayProfile,
		deleteDelayProfile,
		type DelayProfile,
		type DelayProfileInput
	} from '#lib/api/delay-profiles.js';

	interface Props {
		delayProfiles: DelayProfile[];
	}

	let { delayProfiles }: Props = $props();

	let dpModalOpen = $state(false);
	let dpModalMode = $state<'add' | 'edit'>('add');
	let dpEditing = $state<DelayProfile | null>(null);
	let dpSaving = $state(false);

	let dpDeleteOpen = $state(false);
	let dpDeleteTarget = $state<DelayProfile | null>(null);
	let dpDeleting = $state(false);

	let dpName = $state('');
	let dpEnabled = $state(true);
	let dpTorrentDelay = $state(0);
	let dpUsenetDelay = $state(0);
	let dpPreferredProtocol = $state<'torrent' | 'usenet' | ''>('');
	let dpBypassIfHighestQuality = $state(true);
	let dpBypassIfAboveScore = $state<number | null>(null);

	function openAddDelay() {
		dpModalMode = 'add';
		dpEditing = null;
		dpName = '';
		dpEnabled = true;
		dpTorrentDelay = 0;
		dpUsenetDelay = 0;
		dpPreferredProtocol = '';
		dpBypassIfHighestQuality = true;
		dpBypassIfAboveScore = null;
		dpModalOpen = true;
	}

	function openEditDelay(profile: DelayProfile) {
		dpModalMode = 'edit';
		dpEditing = profile;
		dpName = profile.name;
		dpEnabled = profile.enabled ?? true;
		dpTorrentDelay = profile.torrentDelay;
		dpUsenetDelay = profile.usenetDelay;
		dpPreferredProtocol = (profile.preferredProtocol as 'torrent' | 'usenet' | '') ?? '';
		dpBypassIfHighestQuality = profile.bypassIfHighestQuality ?? true;
		dpBypassIfAboveScore = profile.bypassIfAboveScore ?? null;
		dpModalOpen = true;
	}

	async function saveDelay() {
		if (!dpName.trim()) return;
		dpSaving = true;
		try {
			const input: DelayProfileInput = {
				name: dpName.trim(),
				enabled: dpEnabled,
				torrentDelay: dpTorrentDelay,
				usenetDelay: dpUsenetDelay,
				preferredProtocol: dpPreferredProtocol || null,
				bypassIfHighestQuality: dpBypassIfHighestQuality,
				bypassIfAboveScore: dpBypassIfAboveScore
			};
			if (dpModalMode === 'add') {
				await createDelayProfile(input);
				toasts.success(m.settings_quality_delay_created());
			} else {
				await updateDelayProfile(dpEditing!.id, input);
				toasts.success(m.settings_quality_delay_updated());
			}
			dpModalOpen = false;
			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to save');
		} finally {
			dpSaving = false;
		}
	}

	async function deleteDelay() {
		if (!dpDeleteTarget) return;
		dpDeleting = true;
		try {
			await deleteDelayProfile(dpDeleteTarget.id);
			toasts.success(m.settings_quality_delay_deleted({ name: dpDeleteTarget.name }));
			dpDeleteOpen = false;
			dpDeleteTarget = null;
			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete');
		} finally {
			dpDeleting = false;
		}
	}

	function formatDelay(minutes: number): string {
		if (minutes === 0) return m.settings_quality_delay_formatImmediate();
		if (minutes < 60) return `${minutes}m`;
		const h = Math.floor(minutes / 60);
		const m2 = minutes % 60;
		return m2 > 0 ? `${h}h ${m2}m` : `${h}h`;
	}
</script>

<div class="-mt-2 flex items-center justify-between">
	<p class="text-sm text-base-content/60">
		{m.settings_quality_delay_sectionDescription()}
	</p>
	<button class="btn btn-primary btn-sm" onclick={openAddDelay}>
		<Plus class="h-4 w-4" />
		{m.settings_quality_delay_addProfile()}
	</button>
</div>

{#if delayProfiles.length === 0}
	<div class="rounded-lg border border-dashed border-base-300 p-8 text-center">
		<Clock class="mx-auto mb-3 h-10 w-10 text-base-content/30" />
		<p class="font-medium">{m.settings_quality_delay_empty()}</p>
		<p class="mt-1 text-sm text-base-content/60">
			{m.settings_quality_delay_emptyHint()}
		</p>
		<button class="btn mt-4 btn-primary btn-sm" onclick={openAddDelay}>
			<Plus class="h-4 w-4" />
			{m.settings_quality_delay_addProfile()}
		</button>
	</div>
{:else}
	<div class="flex flex-col gap-2">
		{#each delayProfiles as profile (profile.id)}
			<div
				class="flex items-center justify-between rounded-lg border border-base-300 bg-base-100 p-4"
			>
				<div class="flex items-center gap-3">
					<div class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
						<Clock class="h-4 w-4 text-primary" />
					</div>
					<div>
						<div class="flex items-center gap-2">
							<span class="font-medium">{profile.name}</span>
							{#if !profile.enabled}
								<span class="badge badge-ghost badge-sm">
									{m.settings_quality_delay_badgeDisabled()}
								</span>
							{/if}
						</div>
						<div class="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-base-content/60">
							<span
								>{m.settings_quality_delay_torrentPrefix()}
								{formatDelay(profile.torrentDelay)}</span
							>
							<span
								>{m.settings_quality_delay_usenetPrefix()} {formatDelay(profile.usenetDelay)}</span
							>
							{#if profile.preferredProtocol}
								<span>
									{m.settings_quality_delay_preferredPrefix()}
									{profile.preferredProtocol}
								</span>
							{/if}
							{#if profile.bypassIfHighestQuality}
								<span>{m.settings_quality_delay_bypass4k()}</span>
							{/if}
							{#if profile.bypassIfAboveScore != null}
								<span>
									{m.settings_quality_delay_bypassScorePrefix()}
									{profile.bypassIfAboveScore}
								</span>
							{/if}
						</div>
					</div>
				</div>
				<div class="flex items-center gap-2">
					<button class="btn btn-ghost btn-sm" onclick={() => openEditDelay(profile)}>
						<Pencil class="h-4 w-4" />
					</button>
					<button
						class="btn btn-ghost text-error btn-sm"
						onclick={() => {
							dpDeleteTarget = profile;
							dpDeleteOpen = true;
						}}
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<!-- Delay Profile Modal -->
<ModalWrapper open={dpModalOpen} onClose={() => (dpModalOpen = false)}>
	<ModalHeader
		title={dpModalMode === 'add'
			? m.settings_quality_delay_modalAddTitle()
			: m.settings_quality_delay_modalEditTitle()}
		onClose={() => (dpModalOpen = false)}
	/>
	<div class="space-y-5 p-6">
		<div class="form-control">
			<label class="label" for="dp-name">
				<span class="label-text">{m.settings_quality_delay_field_name()}</span>
			</label>
			<input
				id="dp-name"
				type="text"
				class="input-bordered input w-full"
				bind:value={dpName}
				placeholder={m.settings_quality_delay_field_namePlaceholder()}
			/>
		</div>
		<div class="form-control">
			<label class="label cursor-pointer justify-start gap-3">
				<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={dpEnabled} />
				<span class="label-text">{m.settings_quality_delay_field_enabled()}</span>
			</label>
		</div>
		<div class="grid grid-cols-2 gap-4">
			<div class="form-control">
				<label class="label" for="dp-torrent">
					<span class="label-text">{m.settings_quality_delay_field_torrentDelay()}</span>
				</label>
				<input
					id="dp-torrent"
					type="number"
					class="input-bordered input w-full"
					bind:value={dpTorrentDelay}
					min="0"
				/>
				<span class="label-text-alt mt-1 text-base-content/60">{formatDelay(dpTorrentDelay)}</span>
			</div>
			<div class="form-control">
				<label class="label" for="dp-usenet">
					<span class="label-text">{m.settings_quality_delay_field_usenetDelay()}</span>
				</label>
				<input
					id="dp-usenet"
					type="number"
					class="input-bordered input w-full"
					bind:value={dpUsenetDelay}
					min="0"
				/>
				<span class="label-text-alt mt-1 text-base-content/60">{formatDelay(dpUsenetDelay)}</span>
			</div>
		</div>
		<div class="form-control">
			<label class="label" for="dp-preferred">
				<span class="label-text">{m.settings_quality_delay_field_preferredProtocol()}</span>
			</label>
			<select
				id="dp-preferred"
				class="select-bordered select w-full"
				bind:value={dpPreferredProtocol}
			>
				<option value="">{m.settings_quality_delay_option_none()}</option>
				<option value="torrent">{m.settings_quality_delay_option_torrent()}</option>
				<option value="usenet">{m.settings_quality_delay_option_usenet()}</option>
			</select>
		</div>
		<div class="form-control">
			<label class="label cursor-pointer justify-start gap-3">
				<input
					type="checkbox"
					class="toggle toggle-primary toggle-sm"
					bind:checked={dpBypassIfHighestQuality}
				/>
				<span class="label-text">{m.settings_quality_delay_field_bypass4k()}</span>
			</label>
		</div>
		<div class="form-control">
			<label class="label" for="dp-score">
				<span class="label-text">{m.settings_quality_delay_field_bypassScore()}</span>
			</label>
			<input
				id="dp-score"
				type="number"
				class="input-bordered input w-full"
				value={dpBypassIfAboveScore ?? ''}
				oninput={(e) => {
					const v = (e.currentTarget as HTMLInputElement).value;
					dpBypassIfAboveScore = v === '' ? null : parseInt(v, 10);
				}}
				placeholder={m.settings_quality_delay_field_bypassScorePlaceholder()}
			/>
		</div>
	</div>
	<ModalFooter
		onCancel={() => (dpModalOpen = false)}
		onSave={saveDelay}
		saving={dpSaving}
		saveDisabled={!dpName.trim()}
		saveLabel={dpModalMode === 'add'
			? m.settings_quality_delay_createButton()
			: m.settings_general_saveLibrary()}
	/>
</ModalWrapper>

<!-- Delay Profile Delete Confirmation -->
<ConfirmationModal
	open={dpDeleteOpen}
	title={m.settings_quality_delay_deleteTitle()}
	message={m.settings_quality_delay_deleteMessage({ name: dpDeleteTarget?.name ?? '' })}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	loading={dpDeleting}
	onConfirm={deleteDelay}
	onCancel={() => (dpDeleteOpen = false)}
/>
