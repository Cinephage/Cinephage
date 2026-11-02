<script lang="ts">
	import { browser } from '$app/env';
	import { beforeNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { storeLibraryReturnTo } from '#lib/utils/libraryReturnNavigation.js';

	let { children } = $props<{ children: import('svelte').Snippet }>();

	function stripBase(pathname: string): string {
		// resolve('') yields the base path without a leading slash (empty when no base).
		const base = resolve('');
		if (!base) return pathname;
		const prefixed = `/${base}`;
		if (pathname === prefixed) return '/';
		return pathname.startsWith(prefixed) ? pathname.slice(prefixed.length) : pathname;
	}

	beforeNavigate(({ from, to, shallow, type }) => {
		if (shallow && type === 'goto') return;
		if (!browser || !from || !to) return;

		const currentPath = stripBase(window.location.pathname);
		const currentSearch = window.location.search;
		const targetPath = `${stripBase(to.url.pathname)}${to.url.search}${to.url.hash}`;
		storeLibraryReturnTo(currentPath, currentSearch, targetPath);
	});
</script>

{@render children()}
