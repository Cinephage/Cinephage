<script lang="ts">
	import { X } from '@lucide/svelte';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { AlbumEditData } from './music-card.js';

	interface Props {
		open: boolean;
		album: {
			title: string;
			year: number | null;
			primaryType: string | null;
			labelName: string | null;
			catalogNumber: string | null;
			barcode: string | null;
			country: string | null;
		};
		saving: boolean;
		onClose: () => void;
		onSave: (data: AlbumEditData) => void;
	}

	let { open, album, saving, onClose, onSave }: Props = $props();

	let title = $state('');
	let year = $state('');
	let primaryType = $state('');
	let labelName = $state('');
	let catalogNumber = $state('');
	let barcode = $state('');
	let country = $state('');

	// Re-sync whenever the modal opens, so a cancelled edit never leaks back in.
	$effect(() => {
		if (!open) return;
		title = album.title;
		year = album.year ? String(album.year) : '';
		primaryType = album.primaryType ?? '';
		labelName = album.labelName ?? '';
		catalogNumber = album.catalogNumber ?? '';
		barcode = album.barcode ?? '';
		country = album.country ?? '';
	});

	const parsedYear = $derived(year.trim() ? Number.parseInt(year, 10) : null);
	const yearValid = $derived(
		parsedYear === null || (Number.isInteger(parsedYear) && parsedYear >= 1900 && parsedYear <= 2100)
	);
	const canSave = $derived(title.trim().length > 0 && yearValid && !saving);

	function save() {
		if (!canSave) return;
		onSave({
			title: title.trim(),
			year: parsedYear,
			primaryType: primaryType || null,
			labelName: labelName.trim() || null,
			catalogNumber: catalogNumber.trim() || null,
			barcode: barcode.trim() || null,
			country: country.trim() || null
		});
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="lg" labelledBy="album-edit-modal-title">
	<div class="flex items-center justify-between border-b border-base-300 px-6 py-4">
		<h3 id="album-edit-modal-title" class="text-lg font-semibold">{m.music_editAlbumTitle()}</h3>
		<button class="btn btn-ghost btn-sm btn-square" onclick={onClose} aria-label={m.action_close()}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="grid gap-4 px-6 py-5 sm:grid-cols-2">
		<label class="form-control sm:col-span-2">
			<span class="mb-1 text-sm font-medium">{m.common_title()}</span>
			<input class="input w-full input-bordered" bind:value={title} disabled={saving} />
		</label>

		<label class="form-control">
			<span class="mb-1 text-sm font-medium">{m.common_year()}</span>
			<input
				class="input w-full input-bordered"
				bind:value={year}
				disabled={saving}
				inputmode="numeric"
				placeholder="2009"
			/>
			{#if !yearValid}
				<span class="mt-1 text-xs text-error">{m.music_yearInvalid()}</span>
			{/if}
		</label>

		<label class="form-control">
			<span class="mb-1 text-sm font-medium">{m.music_typeLabel()}</span>
			<select class="select w-full select-bordered" bind:value={primaryType} disabled={saving}>
				<option value="">—</option>
				<option value="Album">Album</option>
				<option value="EP">EP</option>
				<option value="Single">Single</option>
				<option value="Broadcast">Broadcast</option>
				<option value="Other">Other</option>
			</select>
		</label>

		<label class="form-control">
			<span class="mb-1 text-sm font-medium">{m.music_labelLabel()}</span>
			<input class="input w-full input-bordered" bind:value={labelName} disabled={saving} />
		</label>

		<label class="form-control">
			<span class="mb-1 text-sm font-medium">{m.music_catalogNumber()}</span>
			<input class="input w-full input-bordered" bind:value={catalogNumber} disabled={saving} />
		</label>

		<label class="form-control">
			<span class="mb-1 text-sm font-medium">{m.music_barcode()}</span>
			<input class="input w-full input-bordered" bind:value={barcode} disabled={saving} />
		</label>

		<label class="form-control">
			<span class="mb-1 text-sm font-medium">{m.music_country()}</span>
			<input class="input w-full input-bordered" bind:value={country} disabled={saving} />
		</label>
	</div>

	<div class="flex justify-end gap-2 border-t border-base-300 px-6 py-4">
		<button class="btn btn-ghost btn-sm" onclick={onClose} disabled={saving}>
			{m.action_cancel()}
		</button>
		<button class="btn btn-primary btn-sm" onclick={save} disabled={!canSave}>
			{saving ? m.common_saving() : m.action_save()}
		</button>
	</div>
</ModalWrapper>
