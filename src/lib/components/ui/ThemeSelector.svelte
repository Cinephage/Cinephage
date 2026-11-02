<script lang="ts">
	import { browser } from '$app/env';
	import { theme } from '#lib/theme.svelte.js';
	import { themes } from '#lib/themes.js';
	import { Palette, Check } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { apiPut } from '#lib/api/client.js';

	let { class: className = 'dropdown-end', showLabel = true, triggerId = '' } = $props();
	let isOpen = $state(false);

	const currentThemeLabel = $derived.by(() => {
		const current = theme.current ?? 'system';
		return current.charAt(0).toUpperCase() + current.slice(1);
	});

	// The account preference rides the same per-user preferences table as
	// language; the cookie mirrors it so the anti-flash script in app.html
	// can render the right theme on the next document before hydration.
	function persistTheme(nextTheme: (typeof themes)[number]) {
		if (!browser) return;
		document.cookie = `cinephage-theme=${nextTheme}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
		void apiPut(`/api/user/preferences/theme`, { value: nextTheme }).catch(() => {
			// Non-critical: the theme still applies locally.
		});
	}

	function toggleDropdown() {
		isOpen = !isOpen;
	}

	function handleThemeChange(nextTheme: (typeof themes)[number]) {
		theme.set(nextTheme);
		persistTheme(nextTheme);
		isOpen = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			isOpen = false;
		}
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.theme-selector')) {
			isOpen = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleClickOutside} />

<div class="theme-selector dropdown {className}" class:dropdown-open={isOpen}>
	<button
		id={triggerId || undefined}
		class="btn w-full justify-between btn-ghost btn-sm"
		onclick={toggleDropdown}
		title={m.ui_selectTheme()}
		aria-haspopup="true"
		aria-expanded={isOpen}
	>
		<Palette class="h-5 w-5" />
		{#if showLabel}
			<span class="ml-2 flex-1 text-left">{m.ui_themeLabel()}</span>
			<span class="ml-2 truncate text-right text-base-content/70">{currentThemeLabel}</span>
		{/if}
	</button>
	<ul
		class="menu dropdown-content z-1 h-96 w-40 flex-col flex-nowrap overflow-x-hidden overflow-y-auto rounded-box bg-base-200 p-2 shadow"
		class:hidden={!isOpen}
		role="menu"
	>
		{#each themes as t (t)}
			<li role="menuitem" class="w-full">
				<button
					class="flex w-full items-center justify-between capitalize"
					class:active={theme.current === t}
					onclick={() => handleThemeChange(t)}
				>
					<span>{t}</span>
					{#if theme.current === t}
						<Check class="h-4 w-4 text-success" />
					{/if}
				</button>
			</li>
		{/each}
	</ul>
</div>
