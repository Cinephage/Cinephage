<script lang="ts">
	import { AlertCircle, Archive, Link, Loader2, Search, Tv, X } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { normalizeLiveTvChannelName } from '#lib/livetv/channel-name-normalizer.js';
	import { copyToClipboard as copyTextToClipboard } from '#lib/utils/clipboard.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type {
		ChannelBackupLink,
		ChannelCategory,
		ChannelLineupItemWithDetails,
		UpdateChannelRequest
	} from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getLineupBackups, deleteLineupBackup, reorderLineupBackups } from '#lib/api/livetv.js';
	import LogoLibraryPicker from './LogoLibraryPicker.svelte';
	import ChannelTechnicalDetails from './ChannelTechnicalDetails.svelte';
	import BackupSourceList from './BackupSourceList.svelte';

	interface Props {
		open: boolean;
		channel: ChannelLineupItemWithDetails | null;
		categories: ChannelCategory[];
		saving: boolean;
		error: string | null;
		onClose: () => void;
		onSave: (id: string, data: UpdateChannelRequest) => void;
		onDelete?: () => void;
		onOpenBackupBrowser?: (lineupItemId: string, excludeChannelId: string) => void;
		onOpenEpgSourcePicker?: (channelId: string) => void;
	}

	let {
		open,
		channel,
		categories,
		saving,
		error,
		onClose,
		onSave,
		onDelete,
		onOpenBackupBrowser,
		onOpenEpgSourcePicker
	}: Props = $props();

	let channelNumber = $state<number | null>(null);
	let customName = $state('');
	let customLogo = $state('');
	let categoryId = $state<string | null>(null);
	let epgId = $state('');
	let epgSourceChannelId = $state<string | null>(null);

	let backups = $state<ChannelBackupLink[]>([]);
	let loadingBackups = $state(false);
	let backupError = $state<string | null>(null);
	let backupSaving = $state(false);

	let technicalDetailsOpen = $state(false);
	let backupsOpen = $state(false);
	let copiedCmd = $state(false);
	let logoPickerOpen = $state(false);

	const channelNumberError = $derived(
		channelNumber !== null && channelNumber < 1
			? m.livetv_channelEditModal_channelNumberError()
			: null
	);

	const customLogoError = $derived(
		customLogo.trim() &&
			!customLogo.trim().match(/^https?:\/\//) &&
			!customLogo.trim().startsWith('/')
			? m.livetv_channelEditModal_customLogoError()
			: null
	);

	const isValid = $derived(!channelNumberError && !customLogoError);

	const normalizedSuggestedName = $derived(
		channel ? normalizeLiveTvChannelName(channel.channel.name, channel.providerType) : ''
	);

	const canApplySuggestedName = $derived(
		normalizedSuggestedName.length > 0 && customName.trim() !== normalizedSuggestedName
	);

	const logoPreviewUrl = $derived.by(() => {
		const trimmed = customLogo.trim();
		if (trimmed && !customLogoError) {
			return trimmed;
		}
		return channel?.displayLogo ?? channel?.channel.logo ?? null;
	});

	const archiveDurationFormatted = $derived(
		formatArchiveDuration(channel?.channel.stalker?.archiveDuration ?? 0)
	);

	$effect(() => {
		if (channel && open) {
			channelNumber = channel.channelNumber;
			customName = channel.customName || '';
			customLogo = channel.customLogo || '';
			categoryId = channel.categoryId;
			epgId = channel.epgId || '';
			epgSourceChannelId = channel.epgSourceChannelId;
			backupError = null;
			copiedCmd = false;
			technicalDetailsOpen = false;
			backupsOpen = false;
			logoPickerOpen = false;
			loadBackups();
		}
	});

	export function refreshBackups() {
		loadBackups();
	}

	export function setEpgSourceChannelId(channelId: string | null) {
		epgSourceChannelId = channelId;
	}

	async function loadBackups() {
		if (!channel) return;
		loadingBackups = true;
		backupError = null;
		try {
			const data = await getLineupBackups(channel.id);
			backups = data.backups || [];
		} catch {
			backupError = m.livetv_channelEditModal_failedToLoadBackups();
		} finally {
			loadingBackups = false;
		}
	}

	async function removeBackup(backupId: string) {
		if (!channel) return;
		const previousBackups = [...backups];
		backups = backups.filter((backup) => backup.id !== backupId);
		backupError = null;

		try {
			await deleteLineupBackup(channel.id, backupId);
		} catch {
			backups = previousBackups;
			backupError = m.livetv_channelEditModal_failedToRemoveBackup();
		}
	}

	async function moveBackupUp(index: number) {
		if (index === 0 || !channel) return;
		const newOrder = [...backups];
		[newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
		backups = newOrder;
		await saveBackupOrder();
	}

	async function moveBackupDown(index: number) {
		if (index >= backups.length - 1 || !channel) return;
		const newOrder = [...backups];
		[newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
		backups = newOrder;
		await saveBackupOrder();
	}

	async function saveBackupOrder() {
		if (!channel) return;
		const previousOrder = [...backups];
		backupSaving = true;
		backupError = null;

		try {
			await reorderLineupBackups(
				channel.id,
				backups.map((backup) => backup.id)
			);
		} catch {
			backups = previousOrder;
			backupError = m.livetv_channelEditModal_failedToReorderBackups();
		} finally {
			backupSaving = false;
		}
	}

	async function copyStreamCommand() {
		if (!channel?.channel.stalker?.cmd) return;
		const copied = await copyTextToClipboard(channel.channel.stalker.cmd);
		if (copied) {
			copiedCmd = true;
			setTimeout(() => {
				copiedCmd = false;
			}, 2000);
		} else {
			toasts.error(m.livetv_channelEditModal_failedToCopy());
		}
	}

	function handleSubmit() {
		if (!channel || saving || !isValid) return;

		const data: UpdateChannelRequest = {
			channelNumber: channelNumber || null,
			customName: customName.trim() || null,
			customLogo: customLogo.trim() || null,
			categoryId,
			epgId: epgId.trim() || null,
			epgSourceChannelId
		};

		onSave(channel.id, data);
	}

	function applySuggestedName() {
		if (!normalizedSuggestedName) return;
		customName = normalizedSuggestedName;
	}

	function clearCustomName() {
		customName = '';
	}

	function clearEpgSource() {
		epgSourceChannelId = null;
	}

	function toggleLogoPicker() {
		logoPickerOpen = !logoPickerOpen;
	}

	function handleLogoSelect(url: string) {
		customLogo = url;
		logoPickerOpen = false;
	}

	function handleLogoClear() {
		customLogo = '';
		logoPickerOpen = false;
	}

	function formatArchiveDuration(hours: number): string {
		if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;
		const days = Math.floor(hours / 24);
		return `${days} day${days !== 1 ? 's' : ''}`;
	}
</script>

{#if channel}
	<ModalWrapper {open} {onClose} maxWidth="xl" labelledBy="channel-edit-modal-title">
		<div class="mb-4 flex items-center justify-between">
			<h3 id="channel-edit-modal-title" class="text-lg font-bold">
				{m.livetv_channelEditModal_title()}
			</h3>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
				<X class="h-4 w-4" />
			</button>
		</div>

		<div class="mb-6 flex items-center gap-3 rounded-lg bg-base-200 p-3">
			{#if logoPreviewUrl}
				<img src={logoPreviewUrl} alt="" class="h-12 w-12 rounded-lg bg-base-300 object-contain" />
			{:else}
				<div class="flex h-12 w-12 items-center justify-center rounded-lg bg-base-300">
					<Tv class="h-6 w-6 text-base-content/30" />
				</div>
			{/if}
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="truncate font-medium">{channel.channel.name}</span>
					{#if channel.channel.stalker?.tvArchive}
						<span class="badge gap-1 badge-xs badge-info">
							<Archive class="h-3 w-3" />
							{m.livetv_channelEditModal_archive()}
						</span>
					{/if}
				</div>
				<div class="text-sm text-base-content/60">{channel.accountName}</div>
			</div>
		</div>

		{#if error}
			<div class="mb-4 alert alert-error">
				<AlertCircle class="h-5 w-5" />
				<div>
					<div class="font-medium">Failed to save</div>
					<div class="text-sm opacity-80">{error}</div>
				</div>
			</div>
		{/if}

		<div class="space-y-3">
			<div>
				<label class="mb-1 block text-sm text-base-content/70" for="channelNumber">
					{m.livetv_channelEditModal_channelNumber()}
				</label>
				<input
					type="number"
					id="channelNumber"
					class="input-bordered input w-full input-sm {channelNumberError ? 'input-error' : ''}"
					bind:value={channelNumber}
					placeholder={String(channel.position)}
					min="1"
				/>
				{#if channelNumberError}
					<p class="mt-1 text-xs text-error">{channelNumberError}</p>
				{/if}
			</div>

			<div>
				<label class="mb-1 block text-sm text-base-content/70" for="customName">
					{m.livetv_channelEditModal_customName()}
				</label>
				<input
					type="text"
					id="customName"
					class="input-bordered input w-full input-sm"
					bind:value={customName}
					placeholder={channel.channel.name}
				/>
				<div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
					<span
						>{m.livetv_channelEditModal_cleanedName({
							name: normalizedSuggestedName || channel.channel.name
						})}</span
					>
					{#if canApplySuggestedName}
						<button type="button" class="btn btn-ghost btn-xs" onclick={applySuggestedName}>
							{m.livetv_channelEditModal_useCleanedName()}
						</button>
					{/if}
					{#if customName.trim()}
						<button type="button" class="btn btn-ghost btn-xs" onclick={clearCustomName}>
							{m.livetv_channelEditModal_useProviderName()}
						</button>
					{/if}
				</div>
			</div>

			<div>
				<label class="mb-1 block text-sm text-base-content/70" for="category"
					>{m.livetv_channelEditModal_category()}</label
				>
				<select
					id="category"
					class="select-bordered select w-full select-sm"
					bind:value={categoryId}
				>
					<option value={null}>{m.livetv_channelEditModal_uncategorized()}</option>
					{#each categories as cat (cat.id)}
						<option value={cat.id}>{cat.name}</option>
					{/each}
				</select>
			</div>

			<div>
				<label class="mb-1 block text-sm text-base-content/70" for="customLogo">
					{m.livetv_channelEditModal_customLogoUrl()}
				</label>
				<div class="relative">
					<div class="flex items-center gap-2">
						<input
							type="url"
							id="customLogo"
							class="input-bordered input flex-1 input-sm {customLogoError ? 'input-error' : ''}"
							bind:value={customLogo}
							placeholder={m.livetv_channelEditModal_customLogoPlaceholder()}
						/>
						<button
							type="button"
							class="btn btn-square shrink-0 btn-outline btn-sm"
							onclick={toggleLogoPicker}
							aria-expanded={logoPickerOpen}
							aria-haspopup="dialog"
							title={m.livetv_channelEditModal_browseLogos()}
						>
							<Search class="h-4 w-4" />
						</button>
					</div>

					<LogoLibraryPicker
						open={logoPickerOpen}
						hasCustomLogo={customLogo.trim().length > 0}
						onSelectLogo={handleLogoSelect}
						onClose={() => (logoPickerOpen = false)}
						onClear={handleLogoClear}
					/>
				</div>
				{#if customLogoError}
					<p class="mt-1 text-xs text-error">{customLogoError}</p>
				{:else}
					<p class="mt-1 text-xs text-base-content/50">
						{m.livetv_channelEditModal_customLogoHint()}
					</p>
				{/if}
			</div>

			<div>
				<label class="mb-1 block text-sm text-base-content/70" for="epgId"
					>{m.livetv_channelEditModal_epgId()}</label
				>
				<input
					type="text"
					id="epgId"
					class="input-bordered input w-full input-sm"
					bind:value={epgId}
					placeholder={m.livetv_channelEditModal_epgIdPlaceholder()}
				/>
				<p class="mt-1 text-xs text-base-content/50">Match with external EPG guide data</p>
			</div>

			<div>
				<div class="mb-1 block text-sm text-base-content/70">
					{m.livetv_channelEditModal_epgSourceOverride()}
				</div>
				{#if epgSourceChannelId && channel.epgSourceChannel}
					<div class="flex items-center gap-2 rounded-lg bg-base-200 px-3 py-2">
						{#if channel.epgSourceChannel.logo}
							<img
								src={channel.epgSourceChannel.logo}
								alt=""
								class="h-8 w-8 rounded bg-base-300 object-contain"
							/>
						{:else}
							<div class="flex h-8 w-8 items-center justify-center rounded bg-base-300">
								<Tv class="h-4 w-4 text-base-content/30" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{channel.epgSourceChannel.name}</div>
							<div class="text-xs text-base-content/50">{channel.epgSourceAccountName}</div>
						</div>
						<button
							type="button"
							class="btn btn-ghost text-error btn-xs"
							onclick={clearEpgSource}
							title="Remove"
						>
							<X class="h-4 w-4" />
						</button>
					</div>
				{:else if epgSourceChannelId}
					<div class="flex items-center gap-2 rounded-lg bg-base-200 px-3 py-2">
						<div class="flex h-8 w-8 items-center justify-center rounded bg-base-300">
							<Link class="h-4 w-4 text-base-content/30" />
						</div>
						<div class="flex-1 text-sm text-base-content/60">
							{m.livetv_channelEditModal_epgSourceSelected()}
						</div>
						<button
							type="button"
							class="btn btn-ghost text-error btn-xs"
							onclick={clearEpgSource}
							title="Remove"
						>
							<X class="h-4 w-4" />
						</button>
					</div>
				{:else}
					<button
						type="button"
						class="btn w-full justify-start gap-2 btn-outline btn-sm"
						onclick={() => onOpenEpgSourcePicker?.(channel.channelId)}
					>
						<Link class="h-4 w-4" />
						{m.livetv_channelEditModal_selectEpgSource()}
					</button>
				{/if}
				<p class="mt-1 text-xs text-base-content/50">Use EPG from another channel</p>
			</div>
		</div>

		<ChannelTechnicalDetails
			open={technicalDetailsOpen}
			onToggle={() => (technicalDetailsOpen = !technicalDetailsOpen)}
			channelName={channel.channel.name}
			channelNumber={channel.channel.number ?? null}
			providerCategory={channel.channel.categoryTitle ?? null}
			tvArchive={!!channel.channel.stalker?.tvArchive}
			{archiveDurationFormatted}
			streamCommand={channel.channel.stalker?.cmd}
			{copiedCmd}
			onCopyStreamCommand={copyStreamCommand}
			accountId={channel.accountId}
			channelDbId={channel.channelId}
		/>

		<BackupSourceList
			open={backupsOpen}
			onToggle={() => (backupsOpen = !backupsOpen)}
			{backups}
			loading={loadingBackups}
			saving={backupSaving}
			error={backupError}
			onMoveUp={moveBackupUp}
			onMoveDown={moveBackupDown}
			onRemove={removeBackup}
			onAddBackup={onOpenBackupBrowser
				? () => onOpenBackupBrowser(channel.id, channel.channelId)
				: undefined}
		/>

		<div class="modal-action mt-4">
			{#if onDelete}
				<button class="btn mr-auto btn-outline btn-error btn-sm" onclick={onDelete}>
					Delete
				</button>
			{/if}

			<button class="btn btn-ghost btn-sm" onclick={onClose} disabled={saving}
				>{m.action_cancel()}</button
			>
			<button class="btn btn-primary btn-sm" onclick={handleSubmit} disabled={saving || !isValid}>
				{#if saving}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				{m.action_save()}
			</button>
		</div>
	</ModalWrapper>
{/if}
