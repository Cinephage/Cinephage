<script lang="ts">
	/**
	 * The metadata block both edit dialogs render: how this item resolves its
	 * language, which locale to force, and whether to prefer the original title.
	 *
	 * It was copied verbatim into the movie and series dialogs, locale table
	 * included; the table and the markup live here now. `idPrefix` keeps the two
	 * forms' element ids distinct when both are mounted.
	 */
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		/** Element id prefix — `movie` or `series`. */
		idPrefix: string;
		mode?: 'inherit' | 'original' | 'explicit';
		value?: string | null;
		preferOriginalTitle?: boolean | null;
	}

	let {
		idPrefix,
		mode = $bindable('inherit'),
		value = $bindable<string | null>('en-US'),
		preferOriginalTitle = $bindable<boolean | null>(null)
	}: Props = $props();

	const LOCALE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
		{ value: 'ar-SA', label: 'Arabic' },
		{ value: 'zh-CN', label: 'Chinese (zh-CN)' },
		{ value: 'zh-TW', label: 'Chinese (zh-TW)' },
		{ value: 'da-DK', label: 'Danish' },
		{ value: 'nl-NL', label: 'Dutch' },
		{ value: 'en-US', label: 'English' },
		{ value: 'fi-FI', label: 'Finnish' },
		{ value: 'fr-FR', label: 'French' },
		{ value: 'de-DE', label: 'German' },
		{ value: 'he-IL', label: 'Hebrew' },
		{ value: 'hi-IN', label: 'Hindi' },
		{ value: 'it-IT', label: 'Italian' },
		{ value: 'ja-JP', label: 'Japanese' },
		{ value: 'ko-KR', label: 'Korean' },
		{ value: 'no-NO', label: 'Norwegian' },
		{ value: 'pl-PL', label: 'Polish' },
		{ value: 'pt-BR', label: 'Portuguese' },
		{ value: 'ru-RU', label: 'Russian' },
		{ value: 'es-ES', label: 'Spanish' },
		{ value: 'sv-SE', label: 'Swedish' },
		{ value: 'th-TH', label: 'Thai' },
		{ value: 'tr-TR', label: 'Turkish' }
	];
</script>

<section>
	<h4
		class="mb-3 border-b border-base-300 pb-1.5 text-xs font-semibold tracking-wider text-base-content/50 uppercase"
	>
		{m.library_metadata_section()}
	</h4>
	<div class="grid grid-cols-2 gap-3">
		<div class="form-control w-full">
			<label class="label py-0.5" for="{idPrefix}-metadata-language-mode">
				<span class="label-text text-xs text-base-content/80"
					>{m.library_metadata_languageLabel()}</span
				>
			</label>
			<select
				id="{idPrefix}-metadata-language-mode"
				bind:value={mode}
				class="select-bordered select w-full select-sm"
			>
				<option value="inherit">{m.library_metadata_inheritGlobal()}</option>
				<option value="original">{m.library_metadata_originalLanguage()}</option>
				<option value="explicit">{m.library_metadata_explicitLocale()}</option>
			</select>
		</div>
		<div class="form-control w-full">
			<label class="label py-0.5" for="{idPrefix}-metadata-language-value">
				<span class="label-text text-xs text-base-content/80">{m.library_metadata_locale()}</span>
			</label>
			<select
				id="{idPrefix}-metadata-language-value"
				bind:value
				disabled={mode !== 'explicit'}
				class="select-bordered select w-full select-sm"
			>
				{#each LOCALE_OPTIONS as option (option.value)}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-center justify-between gap-2">
			<label class="label cursor-pointer">
				<span class="label-text text-xs text-base-content/80"
					>{m.library_metadata_preferOriginalTitle()}</span
				>
				<input
					type="checkbox"
					class="toggle toggle-primary toggle-sm"
					checked={preferOriginalTitle === true}
					onchange={(event) => (preferOriginalTitle = event.currentTarget.checked)}
				/>
			</label>
			{#if preferOriginalTitle !== null}
				<button
					type="button"
					class="btn btn-ghost btn-xs"
					onclick={() => (preferOriginalTitle = null)}
				>
					{m.library_subtitleRequirements_reset()}
				</button>
			{/if}
		</div>
	</div>
</section>
