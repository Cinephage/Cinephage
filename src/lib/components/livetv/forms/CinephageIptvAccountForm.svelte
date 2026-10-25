<script lang="ts">
	import { Globe, X, Loader2, Search } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import { getCinephageIptvCountries } from '#lib/api/livetv.js';

	interface Country {
		code: string;
		name: string;
		flag: string;
	}

	interface Props {
		name: string;
		selectedCountries: string[];
		enabled: boolean;
		mode: 'add' | 'edit';
		onNameChange: (value: string) => void;
		onCountriesChange: (countries: string[]) => void;
		onEnabledChange: (value: boolean) => void;
	}

	let {
		name,
		selectedCountries,
		enabled,
		mode: _mode,
		onNameChange,
		onCountriesChange,
		onEnabledChange
	}: Props = $props();

	let countries = $state<Country[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let searchQuery = $state('');

	const filteredCountries = $derived(
		searchQuery.trim()
			? countries.filter(
					(c) =>
						c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
						c.code.toLowerCase().includes(searchQuery.toLowerCase())
				)
			: countries
	);

	const selectedCountryObjects = $derived(
		selectedCountries
			.map((code) => countries.find((c) => c.code === code))
			.filter(Boolean) as Country[]
	);

	onMount(async () => {
		try {
			const result = await getCinephageIptvCountries();

			if (!result.success) {
				throw new Error(result.error || 'Failed to load countries');
			}

			countries = result.countries;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load countries';
		} finally {
			loading = false;
		}
	});

	function handleSelectChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		const selectedOptions = Array.from(select.selectedOptions);
		const codes = selectedOptions.map((opt) => opt.value);
		onCountriesChange(codes);
	}

	function removeCountry(code: string) {
		onCountriesChange(selectedCountries.filter((c) => c !== code));
	}

	function clearAll() {
		onCountriesChange([]);
	}
</script>

<div class="space-y-4">
	<!-- Name -->
	<div class="form-control">
		<label class="label py-1" for="cinephage-name">
			<span class="label-text">
				Account Name
				<span class="text-error">* </span>
			</span>
		</label>
		<input
			id="cinephage-name"
			type="text"
			class="input-bordered input input-sm"
			value={name}
			oninput={(e) => onNameChange(e.currentTarget.value)}
			placeholder="e.g. US & Canada Free IPTV"
		/>
	</div>

	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
		<!-- Left: Country selection -->
		<div class="space-y-4">
			<SectionHeader title="Countries" />

			{#if loading}
				<div class="flex items-center gap-2 text-base-content/60">
					<Loader2 class="h-4 w-4 animate-spin" />
					<span class="text-sm">Loading countries...</span>
				</div>
			{:else if error}
				<div class="alert-sm alert alert-error">
					<span class="text-sm">{error}</span>
				</div>
			{:else}
				<div class="form-control">
					<label class="label py-1" for="country-select">
						<span class="label-text flex items-center gap-2">
							<Globe class="h-4 w-4" />
							Select Countries
							<span class="text-error">* </span>
							<span class="text-xs text-base-content/60">({countries.length} available)</span>
						</span>
					</label>

					{#if selectedCountryObjects.length > 0}
						<div class="mb-2 flex flex-wrap gap-1">
							{#each selectedCountryObjects as country (country.code)}
								<span class="badge gap-1 badge-sm badge-primary">
									<span>{country.flag}</span>
									<span>{country.name}</span>
									<button
										class="ml-1 hover:text-error"
										onclick={() => removeCountry(country.code)}
										type="button"
										aria-label="Remove {country.name}"
									>
										<X class="h-3 w-3" />
									</button>
								</span>
							{/each}
							{#if selectedCountryObjects.length > 1}
								<button class="btn btn-ghost btn-xs" onclick={clearAll} type="button"
									>Clear All</button
								>
							{/if}
						</div>
					{/if}

					<div class="relative mb-2">
						<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/50" />
						<input
							type="text"
							class="input-bordered input w-full pl-9 input-sm"
							placeholder="Search countries..."
							bind:value={searchQuery}
						/>
						{#if searchQuery}
							<button
								class="absolute top-1/2 right-2 -translate-y-1/2 text-base-content/50 hover:text-base-content"
								onclick={() => (searchQuery = '')}
								type="button"
							>
								<X class="h-4 w-4" />
							</button>
						{/if}
					</div>

					<select
						id="country-select"
						multiple
						class="select-bordered select h-48 w-full overflow-y-auto select-sm"
						onchange={handleSelectChange}
					>
						{#each filteredCountries as country (country.code)}
							<option value={country.code} selected={selectedCountries.includes(country.code)}>
								{country.flag}
								{country.name} ({country.code})
							</option>
						{/each}
					</select>

					<div class="label py-1">
						<span class="label-text-alt text-xs">
							{#if searchQuery}
								{filteredCountries.length} of {countries.length} countries
							{:else if selectedCountries.length === 0}
								Ctrl/Cmd+click to select multiple countries
							{:else}
								{selectedCountries.length} country(s) selected
							{/if}
						</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Right: Settings -->
		<div class="space-y-4">
			<SectionHeader title="Settings" />

			<label class="label cursor-pointer gap-2">
				<input
					type="checkbox"
					class="checkbox checkbox-sm checkbox-primary"
					checked={enabled}
					onchange={(e) => onEnabledChange(e.currentTarget.checked)}
				/>
				<span class="label-text">Enabled</span>
			</label>
		</div>
	</div>
</div>
