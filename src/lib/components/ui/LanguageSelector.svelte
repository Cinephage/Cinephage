<script lang="ts">
	import { Globe, Check } from '@lucide/svelte';
	import { setLocale, getLocale, locales, type Locale } from '#lib/paraglide/runtime.js';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { updateUserLanguage } from '#lib/api/settings.js';

	interface Props {
		class?: string;
		showLabel?: boolean;
		triggerId?: string;
	}

	let { class: className = '', showLabel = false, triggerId = '' }: Props = $props();

	let isOpen = $state(false);
	let currentLocale = $state<Locale>(getLocale());
	let isLoading = $state(false);

	const languageNames: Record<string, string> = {
		en: 'English',
		de: 'Deutsch',
		es: 'Español',
		ru: 'Русский'
	};

	const currentLanguageName = $derived(languageNames[currentLocale] ?? currentLocale);

	async function handleLanguageChange(locale: Locale) {
		if (locale === currentLocale || isLoading) return;

		isLoading = true;
		isOpen = false;

		try {
			await updateUserLanguage(locale);

			// setLocale writes the locale cookie; its default reload re-fetches
			// SSR output in the new locale.
			setLocale(locale);
		} catch (error) {
			// Only show error if it's not a page reload/navigation interruption
			if (error instanceof Error && error.name !== 'AbortError') {
				toasts.error(m.ui_failedToChangeLanguage());
			}
			isLoading = false;
		}
	}

	function toggleDropdown() {
		isOpen = !isOpen;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			isOpen = false;
		}
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.language-selector')) {
			isOpen = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleClickOutside} />

<div class="language-selector dropdown {className}" class:dropdown-open={isOpen}>
	<button
		id={triggerId || undefined}
		class="btn w-full btn-ghost btn-sm"
		class:justify-center={!showLabel}
		class:justify-between={showLabel}
		onclick={toggleDropdown}
		disabled={isLoading}
		title={m.ui_selectLanguage()}
		aria-haspopup="true"
		aria-expanded={isOpen}
	>
		{#if isLoading}
			<span class="loading loading-xs loading-spinner"></span>
		{:else}
			<Globe class="h-5 w-5" />
		{/if}
		{#if showLabel}
			<span class="ml-2 flex-1 text-left">{m.ui_languageLabel()}</span>
			<span class="ml-2 truncate text-right text-base-content/70">{currentLanguageName}</span>
		{/if}
	</button>

	<ul
		class="menu dropdown-content z-1 w-40 rounded-box bg-base-200 p-2 shadow"
		class:hidden={!isOpen}
		role="menu"
	>
		{#each locales as locale (locale)}
			<li role="menuitem">
				<button
					class="flex items-center justify-between"
					class:active={locale === currentLocale}
					onclick={() => handleLanguageChange(locale)}
					disabled={isLoading}
				>
					<span>{languageNames[locale] ?? locale}</span>
					{#if locale === currentLocale}
						<Check class="h-4 w-4 text-success" />
					{/if}
				</button>
			</li>
		{/each}
	</ul>
</div>
