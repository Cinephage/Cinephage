<script lang="ts">
	import { Loader2, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getLogos } from '#lib/api/logos.js';
	import { getLogoCountries } from '#lib/api/settings.js';

	interface LogoLibraryItem {
		path: string;
		country: string;
		name: string;
		filename: string;
		url: string;
	}

	interface LogoCountryOption {
		code: string;
		name: string;
		logoCount: number;
	}

	interface Props {
		open: boolean;
		hasCustomLogo: boolean;
		onSelectLogo: (url: string) => void;
		onClose: () => void;
		onClear: () => void;
	}

	let { open, hasCustomLogo, onSelectLogo, onClose, onClear }: Props = $props();

	let search = $state('');
	let country = $state('');
	let loading = $state(false);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let items = $state<LogoLibraryItem[]>([]);
	let countries = $state<LogoCountryOption[]>([]);
	let libraryReady = $state<boolean | null>(null);
	let offset = $state(0);
	let hasMore = $state(false);
	let requestId = 0;

	$effect(() => {
		if (open) {
			search = '';
			country = '';
			loading = false;
			loadingMore = false;
			error = null;
			items = [];
			countries = [];
			libraryReady = null;
			offset = 0;
			hasMore = false;
		}
	});

	$effect(() => {
		if (!open) return;

		const currentSearch = search;
		const currentCountry = country;
		const timer = setTimeout(() => {
			loadLogoLibrary(currentSearch, currentCountry);
		}, 250);

		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (!open || countries.length > 0 || libraryReady === false) return;
		loadLogoCountries();
	});

	async function loadLogoCountries() {
		try {
			const body = (await getLogoCountries()) as unknown as {
				success?: boolean;
				code?: string;
				data?: LogoCountryOption[];
			};

			if (!body?.success) {
				if (body?.code === 'NOT_DOWNLOADED') {
					libraryReady = false;
				}
				return;
			}

			countries = body.data ?? [];
		} catch {
			// Ignore country filter failures
		}
	}

	function handleScroll(event: Event) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLDivElement)) return;

		const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 48;
		if (!nearBottom || loading || loadingMore || !hasMore) return;

		loadLogoLibrary(search, country, true);
	}

	async function loadLogoLibrary(searchText = '', countryFilter = '', append = false) {
		if (append && (loading || loadingMore || !hasMore)) {
			return;
		}

		const currentRequestId = ++requestId;
		const currentOffset = append ? offset : 0;

		if (append) {
			loadingMore = true;
		} else {
			loading = true;
			items = [];
			offset = 0;
			hasMore = false;
		}

		error = null;

		try {
			const params: Record<string, string> = {
				limit: '18',
				offset: String(currentOffset)
			};
			if (searchText.trim()) params.search = searchText.trim();
			if (countryFilter) params.country = countryFilter;

			const body = (await getLogos(params)) as unknown as {
				success?: boolean;
				code?: string;
				error?: string;
				data?: LogoLibraryItem[];
				pagination?: { hasMore?: boolean };
			};

			if (currentRequestId !== requestId) return;

			if (!body?.success) {
				items = [];
				offset = 0;
				hasMore = false;
				if (body?.code === 'NOT_DOWNLOADED') {
					libraryReady = false;
					error = 'Download logos from the Live TV channels page to browse the logo library.';
				} else {
					libraryReady = null;
					error = body?.error || 'Failed to load logos';
				}
				return;
			}

			libraryReady = true;
			const nextItems = body.data ?? [];
			items = append ? [...items, ...nextItems] : nextItems;
			offset = currentOffset + nextItems.length;
			hasMore = body.pagination?.hasMore ?? false;
		} catch {
			if (currentRequestId !== requestId) return;

			libraryReady = null;
			items = [];
			error = 'Failed to load logos';
		} finally {
			if (currentRequestId === requestId) {
				loading = false;
				loadingMore = false;
			}
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-40"
		onclick={onClose}
		onkeydown={(e) => e.key === 'Escape' && onClose()}
		role="button"
		tabindex="-1"
	></div>

	<div
		class="absolute inset-x-0 z-50 mt-2 rounded-xl border border-base-content/10 bg-base-100 p-3 shadow-xl"
	>
		<div class="mb-3 flex items-center gap-2">
			<div class="relative flex-1">
				<Search
					class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
				/>
				<input
					type="text"
					class="input-bordered input w-full pl-9 input-sm"
					placeholder={m.livetv_channelEditModal_searchLogosPlaceholder()}
					bind:value={search}
				/>
			</div>
			<select
				class="select-bordered select w-36 select-sm"
				bind:value={country}
				disabled={countries.length === 0 || libraryReady === false}
			>
				<option value="">{m.livetv_channelEditModal_allCountries()}</option>
				{#each countries as countryOption (countryOption.code)}
					<option value={countryOption.code}>
						{countryOption.name} ({countryOption.logoCount})
					</option>
				{/each}
			</select>
		</div>

		<div class="max-h-64 overflow-y-auto rounded-lg bg-base-200/60 p-1" onscroll={handleScroll}>
			{#if loading}
				<div class="flex items-center justify-center py-8 text-base-content/60">
					<Loader2 class="h-5 w-5 animate-spin" />
				</div>
			{:else if error}
				<div class="px-3 py-6 text-center text-sm text-base-content/60">
					{error}
				</div>
			{:else if items.length === 0}
				<div class="px-3 py-6 text-center text-sm text-base-content/60">
					{m.livetv_channelEditModal_noLogosMatch()}
				</div>
			{:else}
				<div class="space-y-1">
					{#each items as logoItem (logoItem.path)}
						<button
							type="button"
							class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-base-100"
							onclick={() => onSelectLogo(logoItem.url)}
						>
							<img src={logoItem.url} alt="" class="h-9 w-9 rounded bg-base-100 object-contain" />
							<div class="min-w-0 flex-1">
								<div class="truncate text-sm font-medium">{logoItem.name}</div>
								<div class="truncate text-xs text-base-content/50">
									{logoItem.country}
								</div>
							</div>
						</button>
					{/each}
					{#if loadingMore}
						<div class="flex items-center justify-center py-2 text-base-content/60">
							<Loader2 class="h-4 w-4 animate-spin" />
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<div class="mt-3 flex items-center justify-between gap-2">
			<p class="text-xs text-base-content/50">
				{m.livetv_channelEditModal_pasteOrPickLogo()}
			</p>
			<div class="flex items-center gap-2">
				{#if hasCustomLogo}
					<button type="button" class="btn btn-ghost btn-xs" onclick={onClear}> Clear </button>
				{/if}
				<button type="button" class="btn btn-ghost btn-xs" onclick={onClose}> Done </button>
			</div>
		</div>
	</div>
{/if}
