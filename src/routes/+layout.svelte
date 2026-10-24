<script lang="ts">
	import './layout.css';
	import { browser } from '$app/env';
	import { goto, refreshAll } from '$app/navigation';
	import type { ReadonlyURL } from '$app/state';
	import { ThemeSelector, LanguageSelector, UserAvatar } from '#lib/components/ui/index.js';
	import { NotificationBell } from '#lib/components/requests/index.js';
	import Toasts from '#lib/components/ui/Toasts.svelte';
	import { layoutState, type ScanProgressPayload } from '#lib/layout.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import { createSSE } from '#lib/sse/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	import { page } from '$app/state';
	import { resolvePath } from '#lib/utils/routing.js';
	import { authClient } from '#lib/auth/client.js';
	import { getSystemStatus } from '#lib/api/settings.js';
	import { PLACEHOLDER_PACKAGE_VERSION } from '#lib/version.js';
	import {
		Menu,
		Home,
		Clapperboard,
		Tv,
		Settings,
		ChevronLeft,
		ChevronRight,
		ChevronDown,
		Compass,
		Library,
		User,
		List,
		Radio,
		Calendar,
		Activity,
		FileQuestion,
		LogOut,
		Server,
		Download,
		Wifi,
		WifiOff,
		Loader2,
		Puzzle,
		FolderCog,
		Ban,
		Users,
		Globe,
		Palette,
		Pin,
		Inbox
	} from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	const GITHUB_URL = 'https://github.com/cinephage/cinephage';
	const DISCORD_URL = 'https://discord.gg/scGCBTSWEt';

	type MenuChildItem = {
		href: string;
		label: () => string;
		icon?: typeof Home;
		// Matches against the readonly page.url shape (SvelteKit 3).
		match?: (url: ReadonlyURL) => boolean;
		isSubtype?: boolean;
	};

	type MenuItem = {
		href?: string;
		label: () => string;
		icon: typeof Home;
		children?: MenuChildItem[];
	};

	type LibraryNavItem = {
		id: string;
		slug: string;
		name: string;
		mediaSubType: string | null;
		isDefault: boolean;
	};

	let { children, data } = $props<{
		children: import('svelte').Snippet;
		data: {
			libraryNav?: {
				movieLibraries?: LibraryNavItem[];
				tvLibraries?: LibraryNavItem[];
			};
		};
	}>();
	let isMobileDrawerOpen = $state(false);
	let isLoggingOut = $state(false);
	let expandedMenuSection = $state<string | null>(null);
	let pinnedMenuSections = $state<Set<string>>(new Set());

	// Which header's notification bell keeps its SSE stream open. The
	// headers themselves swap via CSS (no SSR flash); this state only picks
	// the active bell so a single stream exists per tab.
	let isDesktopLayout = $state(false);
	$effect(() => {
		const mq = window.matchMedia('(min-width: 1024px)');
		isDesktopLayout = mq.matches;
		const onChange = (e: MediaQueryListEvent) => (isDesktopLayout = e.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});
	const SIDEBAR_EXPANDED_STORAGE_KEY = 'cinephage.sidebar.expanded';
	const PINNED_SECTIONS_STORAGE_KEY = 'cinephage.sidebar.pinned';

	function usesFocusedLayout(pathname: string): boolean {
		return (
			pathname === '/setup' ||
			pathname.startsWith('/setup/') ||
			pathname === '/login' ||
			pathname.startsWith('/login/')
		);
	}

	function closeMobileDrawer(): void {
		isMobileDrawerOpen = false;
	}

	function buildNavHref(href: string): string {
		if (href === '/library/import' && page.url.pathname === '/library/import') {
			return resolvePath(`/library/import?newSession=${Date.now()}`);
		}
		return resolvePath(href);
	}

	function handleNavClick(event: MouseEvent, href: string): void {
		closeMobileDrawer();
		if (href === '/library/import' && page.url.pathname === '/library/import') {
			event.preventDefault();
			void goto(buildNavHref(href));
		}
	}

	function isChildActive(child: MenuChildItem): boolean {
		if (child.match) return child.match(page.url);
		const [childPath, childQuery] = child.href.split('?');
		if (page.url.pathname !== childPath) return false;
		if (!childQuery) return true;
		const queryParams = new URLSearchParams(childQuery);
		for (const [key, value] of queryParams) {
			if (page.url.searchParams.get(key) !== value) return false;
		}
		return true;
	}

	function isItemActive(item: MenuItem): boolean {
		if (item.children) {
			return item.children.some((child) => isChildActive(child));
		}
		if (!item.href) return false;
		if (item.href === '/') return page.url.pathname === '/';
		return page.url.pathname === item.href || page.url.pathname.startsWith(`${item.href}/`);
	}

	function getMenuSectionKey(item: MenuItem): string {
		return item.label();
	}

	function handleCollapsedParentClick(item: MenuItem): void {
		expandedMenuSection = getMenuSectionKey(item);
		layoutState.isSidebarExpanded = true;
	}

	function handleSubmenuToggle(item: MenuItem): void {
		const key = getMenuSectionKey(item);
		if (pinnedMenuSections.has(key)) {
			// Clicking a pinned section un-pins and collapses it
			togglePinnedSection(key);
			expandedMenuSection = null;
			return;
		}
		expandedMenuSection = expandedMenuSection === key ? null : key;
	}

	function togglePinnedSection(key: string): void {
		const next = new SvelteSet(pinnedMenuSections);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
			// Ensure the section is visually open immediately
			expandedMenuSection = key;
		}
		pinnedMenuSections = next;
		if (browser) {
			try {
				localStorage.setItem(PINNED_SECTIONS_STORAGE_KEY, JSON.stringify([...next]));
			} catch {
				// storage unavailable (blocked cookies / ETP)
			}
		}
	}

	function openFooterDropdownOnExpand(type: 'language' | 'theme'): void {
		layoutState.isSidebarExpanded = true;
		const triggerId = type === 'language' ? 'sidebar-language-trigger' : 'sidebar-theme-trigger';
		const tryOpen = (attempt = 0) => {
			const trigger = document.getElementById(triggerId) as HTMLElement | null;
			if (!trigger) {
				if (attempt < 5) {
					setTimeout(() => tryOpen(attempt + 1), 40);
				}
				return;
			}
			trigger.focus();
			trigger.click();
		};
		setTimeout(() => tryOpen(), 60);
	}

	async function handleLogout(): Promise<void> {
		if (isLoggingOut) return;
		isLoggingOut = true;
		try {
			await authClient.signOut();
			// Drop all server-loaded state (the root layout carries user
			// identity) before leaving the app.
			await refreshAll();
			await goto('/login');
		} catch {
			// Error handled by auth client
		} finally {
			isLoggingOut = false;
		}
	}

	// Menu items using translation functions. Viewer accounts see the shared
	// browsing surfaces only (Discover, Library, Calendar); everything
	// operational (dashboard, import, activity, Live TV, settings) is admin.
	const menuItems = $derived.by<MenuItem[]>(() => {
		const movieLibraries = data.libraryNav?.movieLibraries ?? [];
		const tvLibraries = data.libraryNav?.tvLibraries ?? [];
		const defaultMovieLibrary =
			movieLibraries.find((library: LibraryNavItem) => library.isDefault) ?? null;
		const defaultTvLibrary =
			tvLibraries.find((library: LibraryNavItem) => library.isDefault) ?? null;
		const movieSubLibraries = movieLibraries.filter(
			(library: LibraryNavItem) => !library.isDefault
		);
		const tvSubLibraries = tvLibraries.filter((library: LibraryNavItem) => !library.isDefault);
		const isAdmin = data.user?.role === 'admin';

		const libraryChildren: MenuChildItem[] = [
			{
				href: '/library/movies',
				label: m.nav_movies,
				icon: Clapperboard,
				match: (url: ReadonlyURL) => {
					if (url.pathname.startsWith('/library/movie/')) return true;
					if (url.pathname !== '/library/movies') return false;
					const currentLibrarySlug = url.searchParams.get('library')?.trim() ?? '';
					if (!currentLibrarySlug) return true;
					return currentLibrarySlug === (defaultMovieLibrary?.slug ?? '');
				}
			},
			...movieSubLibraries.map((library: LibraryNavItem) => ({
				href: `/library/movies?library=${encodeURIComponent(library.slug)}`,
				label: () => library.name,
				isSubtype: true,
				match: (url: ReadonlyURL) =>
					url.pathname === '/library/movies' &&
					(url.searchParams.get('library')?.trim() ?? '') === library.slug
			})),
			{
				href: '/library/tv',
				label: m.nav_tvShows,
				icon: Tv,
				match: (url: ReadonlyURL) => {
					if (url.pathname.startsWith('/library/tv/')) return true;
					if (url.pathname !== '/library/tv') return false;
					const currentLibrarySlug = url.searchParams.get('library')?.trim() ?? '';
					if (!currentLibrarySlug) return true;
					return currentLibrarySlug === (defaultTvLibrary?.slug ?? '');
				}
			},
			...tvSubLibraries.map((library: LibraryNavItem) => ({
				href: `/library/tv?library=${encodeURIComponent(library.slug)}`,
				label: () => library.name,
				isSubtype: true,
				match: (url: ReadonlyURL) =>
					url.pathname === '/library/tv' &&
					(url.searchParams.get('library')?.trim() ?? '') === library.slug
			})),
			...(isAdmin
				? [
						{ href: '/library/import', label: m.nav_import, icon: Download },
						{ href: '/library/unmatched', label: m.nav_unmatchedFiles, icon: FileQuestion }
					]
				: [])
		];

		const discoverItem: MenuItem = { href: '/discover', label: m.nav_discover, icon: Compass };
		const libraryItem: MenuItem = {
			label: m.nav_library,
			icon: Library,
			children: libraryChildren
		};
		const calendarItem: MenuItem = { href: '/calendar', label: m.nav_calendar, icon: Calendar };
		const requestsItem: MenuItem = {
			href: '/requests',
			label: m.nav_requests,
			icon: Inbox
		};

		if (!isAdmin) {
			return [discoverItem, libraryItem, calendarItem, requestsItem];
		}

		return [
			{ href: '/', label: m.nav_home, icon: Home },
			discoverItem,
			libraryItem,
			{ href: '/activity', label: m.nav_activity, icon: Activity },
			calendarItem,
			requestsItem,
			{
				label: m.nav_liveTv,
				icon: Radio,
				children: [
					{ href: '/livetv/channels', label: m.nav_channels, icon: Tv },
					{ href: '/livetv/epg', label: m.nav_epg, icon: Calendar },
					{ href: '/livetv/accounts', label: m.nav_accounts, icon: User }
				]
			},
			{ href: '/smartlists', label: m.nav_smartLists, icon: List },
			{
				label: m.nav_settings,
				icon: Settings,
				children: [
					{
						href: '/settings/library/libraries',
						label: m.nav_libraryStorage,
						icon: FolderCog,
						match: (url: ReadonlyURL) => url.pathname.startsWith('/settings/library')
					},
					{
						href: '/settings/integrations/indexers',
						label: m.nav_integrations,
						icon: Puzzle,
						match: (url: ReadonlyURL) => url.pathname.startsWith('/settings/integrations')
					},
					{
						href: '/settings/users',
						label: m.nav_users,
						icon: Users,
						match: (url: ReadonlyURL) => url.pathname.startsWith('/settings/users')
					},
					{
						href: '/settings/system/general',
						label: m.nav_system,
						icon: Server,
						match: (url: ReadonlyURL) => url.pathname.startsWith('/settings/system')
					},
					{
						href: '/settings/blocklist/releases',
						label: m.nav_blocklist,
						icon: Ban,
						match: (url: ReadonlyURL) => url.pathname.startsWith('/settings/blocklist')
					},
					{
						href: '/settings/monitoring/status',
						label: m.nav_monitoring,
						icon: Activity,
						match: (url: ReadonlyURL) => url.pathname.startsWith('/settings/monitoring')
					}
				]
			}
		];
	});

	let appVersion = $state('');

	async function refreshAppVersion(): Promise<void> {
		if (!browser) return;
		try {
			const payload = (await getSystemStatus()) as { version?: string };
			const candidate = payload.version?.trim();
			if (!candidate || candidate === PLACEHOLDER_PACKAGE_VERSION) {
				appVersion = 'dev-local';
				return;
			}
			appVersion = candidate;
		} catch {
			// Keep current version badge if runtime check fails
		}
	}

	const useFocusedLayout = $derived(usesFocusedLayout(page.url.pathname));

	$effect(() => {
		if (useFocusedLayout) {
			closeMobileDrawer();
		}
	});

	$effect(() => {
		void page.url.pathname;
		layoutState.clearMobileSseStatus();
	});

	$effect(() => {
		if (!browser) return;

		void refreshAppVersion();

		const interval = window.setInterval(() => {
			void refreshAppVersion();
		}, 60_000);

		const handleFocus = () => {
			void refreshAppVersion();
		};
		const handleVisibility = () => {
			if (document.visibilityState === 'visible') {
				void refreshAppVersion();
			}
		};

		window.addEventListener('focus', handleFocus);
		document.addEventListener('visibilitychange', handleVisibility);

		return () => {
			window.clearInterval(interval);
			window.removeEventListener('focus', handleFocus);
			document.removeEventListener('visibilitychange', handleVisibility);
		};
	});

	$effect(() => {
		if (!browser) return;
		// Storage access throws when site data is blocked (Firefox ETP etc.)
		let stored: string | null = null;
		let storedPinned: string | null = null;
		try {
			stored = localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
			storedPinned = localStorage.getItem(PINNED_SECTIONS_STORAGE_KEY);
		} catch {
			// storage unavailable (blocked cookies / ETP)
		}
		if (stored === 'true' || stored === 'false') {
			layoutState.isSidebarExpanded = stored === 'true';
		}
		if (storedPinned) {
			try {
				const keys = JSON.parse(storedPinned);
				if (Array.isArray(keys)) {
					pinnedMenuSections = new Set(keys as string[]);
				}
			} catch {
				// ignore malformed data
			}
		}
	});

	$effect(() => {
		if (!browser) return;
		try {
			localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(layoutState.isSidebarExpanded));
		} catch {
			// storage unavailable (blocked cookies / ETP)
		}
	});

	// Global scan SSE - lives in the root layout so toast notifications fire
	// regardless of which page the user is on when a scan completes.
	// The monitoring/status sub-layout keeps its own SSE for the progress bar.
	// Operational streams are admin-only; viewer accounts never connect.
	const isAdminUser = $derived(data.user?.role === 'admin');
	// Connections are opened once per component lifetime; a role change
	// requires a full re-authentication and page load, so the initial value
	// is deliberate.
	// svelte-ignore state_referenced_locally
	const _scanSse =
		isAdminUser &&
		createSSE<{
			status: { scanning?: boolean };
			progress: ScanProgressPayload;
			scanStart: Record<string, unknown>;
			scanComplete: { type?: string; results?: unknown[] };
			scanError: { error?: { message?: string } };
		}>('/api/library/scan/status', {
			status: (payload) => {
				const inProgress = Boolean(payload.scanning ?? false);
				layoutState.setScanState(inProgress, inProgress ? layoutState.scanProgress : null);
			},
			progress: (payload) => {
				layoutState.setScanState(true, payload);
			},
			scanStart: () => {
				layoutState.setScanState(true, layoutState.scanProgress);
			},
			scanComplete: (payload) => {
				layoutState.setScanState(false, null);
				const count = payload.results?.length ?? 0;
				toasts.success(m.settings_general_scanCompleteFoldersScanned({ count }));
				void refreshAll();
			},
			scanError: () => {
				layoutState.setScanState(false, null);
				toasts.error(m.settings_general_scanFailed());
			}
		});

	// Global sync SSE — shows start/complete toasts from any page.
	// svelte-ignore state_referenced_locally
	const _syncSse =
		isAdminUser &&
		createSSE<{
			status: { inProgress?: boolean };
			syncStart: { timestamp?: string };
			syncStop: { timestamp?: string };
		}>('/api/media-server-stats/sync/status', {
			status: (payload) => {
				layoutState.setMediaServerSyncing(Boolean(payload.inProgress ?? false));
			},
			syncStart: () => {
				layoutState.setMediaServerSyncing(true);
				toasts.info(m.settings_monitoring_mediaServerSyncStarted());
			},
			syncStop: () => {
				layoutState.setMediaServerSyncing(false);
				toasts.success(m.settings_monitoring_mediaServerSyncComplete());
				void refreshAll();
			}
		});
</script>

<svelte:head>
	<link rel="icon" type="image/png" href="/logo.png" />
</svelte:head>

{#if useFocusedLayout}
	{@render children()}
{:else}
	<div class="drawer lg:drawer-open">
		<input
			id="main-drawer"
			type="checkbox"
			class="drawer-toggle"
			bind:checked={isMobileDrawerOpen}
		/>
		<div class="drawer-content flex min-h-screen flex-col bg-base-100 text-base-content">
			<!-- Both headers render and swap via CSS (SSR ships the right one
			     with no hydration flash); the notification bell mounts in each
			     but only the breakpoint-active instance opens its SSE stream. -->
			<!-- Mobile Header -->
			<header class="navbar sticky top-0 z-50 bg-base-200 shadow-sm lg:hidden">
				<div class="flex-none">
					<label
						for="main-drawer"
						aria-label={m.nav_openSidebar()}
						class="btn btn-square btn-ghost"
					>
						<Menu class="h-6 w-6" />
					</label>
				</div>
				<div class="mx-2 flex min-w-0 flex-1 items-center gap-2 px-2">
					<img src="/logo.png" alt="" class="h-8 w-8 rounded" />
					<div class="relative min-w-0">
						<span class="block truncate pr-10 text-xl leading-tight font-bold"
							>{m.common_appName()}</span
						>

						<span
							class="absolute -top-1 right-0 badge h-4 min-h-4 px-1 badge-xs font-semibold badge-warning"
						>
							{m.common_alpha()}
						</span>
					</div>
				</div>
				<div class="flex flex-none items-center gap-2 pr-2">
					<NotificationBell enabled={!isDesktopLayout} />
					{#if layoutState.mobileSseStatus === 'connected'}
						<span class="badge shrink-0 gap-1 badge-success">
							<Wifi class="h-3 w-3" />
							{m.common_live()}
						</span>
					{:else if layoutState.mobileSseStatus === 'error'}
						<span class="badge shrink-0 gap-1 badge-error">
							<WifiOff class="h-3 w-3" />
							{m.common_reconnecting()}
						</span>
					{:else if layoutState.mobileSseStatus === 'connecting'}
						<span class="badge shrink-0 gap-1 badge-warning">
							<Loader2 class="h-3 w-3 animate-spin" />
							{m.common_connecting()}
						</span>
					{/if}
				</div>
			</header>
			<!-- Desktop top bar -->
			<header
				class="sticky top-0 z-30 hidden h-12 items-center justify-end border-b border-base-300/60 bg-base-100/90 px-4 backdrop-blur lg:flex"
			>
				<NotificationBell enabled={isDesktopLayout} />
			</header>

			<!-- Page Content -->
			<main class="w-full grow p-4">
				{@render children()}
			</main>
		</div>

		<!-- Sidebar -->
		<div class="drawer-side z-40 overflow-visible">
			<label for="main-drawer" aria-label={m.nav_closeSidebar()} class="drawer-overlay"></label>
			<aside
				class:sidebar-collapsed={!layoutState.isSidebarExpanded}
				class="relative z-40 flex h-dvh flex-col overflow-x-visible bg-base-200 transition-[width] duration-300 ease-in-out
		            {layoutState.isSidebarExpanded ? 'w-64' : 'w-20'}"
			>
				<!-- Sidebar Header -->
				<div
					class="relative flex h-16 items-center border-b border-base-300"
					class:px-4={layoutState.isSidebarExpanded}
					class:px-2={!layoutState.isSidebarExpanded}
					class:justify-between={layoutState.isSidebarExpanded}
					class:justify-center={!layoutState.isSidebarExpanded}
				>
					{#if layoutState.isSidebarExpanded}
						<div class="flex min-w-0 items-center gap-2">
							<img src="/logo.png" alt="" class="h-7 w-7 rounded" />
							<div class="relative min-w-0">
								<span class="block truncate pr-10 text-xl leading-tight font-bold"
									>{m.common_appName()}</span
								>

								<span
									class="absolute -top-1 right-0 badge h-4 min-h-4 px-1 badge-xs font-semibold badge-warning"
								>
									{m.common_alpha()}
								</span>
							</div>
						</div>
					{:else}
						<div class="relative -mr-1 -ml-3">
							<div class="grid h-11 w-11 place-items-center rounded-lg bg-base-100/70">
								<img
									src="/logo.png"
									alt={m.common_appName()}
									class="h-9 w-9 rounded object-contain"
								/>
							</div>
							<span
								class="absolute bottom-[-0.35rem] left-1/2 badge h-4 min-h-4 -translate-x-1/2 px-1 badge-xs font-semibold badge-warning"
							>
								{m.common_alphaShort()}
							</span>
						</div>
					{/if}
					<button
						class="absolute top-1/2 right-0 z-50 hidden h-6.5 w-6.5 translate-x-1/2 -translate-y-1/2 items-center justify-center overflow-visible rounded-full border border-black/35 bg-base-100/95 shadow-sm transition-colors hover:border-black/45 hover:bg-base-100 lg:flex"
						onclick={() => layoutState.toggleSidebar()}
						aria-label={m.action_toggleSidebar()}
						type="button"
					>
						{#if layoutState.isSidebarExpanded}
							<ChevronLeft class="h-4 w-4" style="stroke-width: 2.8;" />
						{:else}
							<ChevronRight class="h-4 w-4" style="stroke-width: 2.8;" />
						{/if}
					</button>
				</div>

				<!-- Navigation -->
				<div
					class="min-h-0 grow overflow-y-auto"
					class:px-2={layoutState.isSidebarExpanded}
					class:pl-2={!layoutState.isSidebarExpanded}
					class:pr-0={!layoutState.isSidebarExpanded}
					class:pt-2={layoutState.isSidebarExpanded}
					class:pt-1={!layoutState.isSidebarExpanded}
				>
					<ul
						class="menu flex-nowrap gap-1 {layoutState.isSidebarExpanded
							? ''
							: 'sidebar-collapsed-shell px-1 py-2'}"
					>
						{#each menuItems as item (item.label)}
							<li class={layoutState.isSidebarExpanded ? 'w-full' : 'mx-auto w-11'}>
								{#if item.children}
									{#if layoutState.isSidebarExpanded}
										{@const sectionKey = getMenuSectionKey(item)}
										{@const isPinned = pinnedMenuSections.has(sectionKey)}
										<details
											open={isItemActive(item) || expandedMenuSection === sectionKey || isPinned}
											class="group/nav-section"
										>
											<summary
												class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5"
												class:active-nav={isItemActive(item)}
												onclick={(event) => {
													event.preventDefault();
													handleSubmenuToggle(item);
												}}
											>
												<item.icon class="h-4.5 w-4.5 shrink-0" />
												<span class="truncate">{item.label()}</span>
												<button
													type="button"
													class="ml-auto rounded p-0.5 transition-all {isPinned
														? 'text-primary opacity-90'
														: 'opacity-0 group-hover/nav-section:opacity-40 hover:opacity-70!'}"
													title={isPinned ? 'Unpin menu' : 'Pin menu open'}
													onclick={(event) => {
														event.stopPropagation();
														togglePinnedSection(sectionKey);
													}}
												>
													<Pin class="h-3 w-3 {isPinned ? 'fill-primary' : ''}" />
												</button>
												<ChevronDown
													class="nav-chevron h-4 w-4 shrink-0 text-base-content/60 transition-transform duration-200 group-open/nav-section:rotate-180 {isPinned
														? 'opacity-30'
														: ''}"
												/>
											</summary>
											<ul>
												{#each item.children as child (child.href)}
													<li>
														<a
															href={buildNavHref(child.href)}
															class="flex w-full items-center gap-3 rounded-lg px-3 py-2"
															class:pl-8={child.isSubtype}
															class:active={isChildActive(child)}
															onclick={(event) => handleNavClick(event, child.href)}
														>
															{#if child.icon}
																<child.icon class="h-4.25 w-4.25 shrink-0" />
															{/if}
															{#if child.isSubtype}
																<span class="font-mono text-xs text-base-content/40">|-</span>
															{/if}
															<span class="truncate">{child.label()}</span>
														</a>
													</li>
												{/each}
											</ul>
										</details>
									{:else}
										<button
											class="flex w-full items-center justify-center rounded-lg px-3 py-3"
											class:active-nav={isItemActive(item)}
											onclick={() => handleCollapsedParentClick(item)}
											title={item.label()}
										>
											<item.icon class="h-5 w-5 shrink-0" />
										</button>
									{/if}
								{:else}
									<a
										href={buildNavHref(item.href!)}
										class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5"
										class:justify-center={!layoutState.isSidebarExpanded}
										class:py-3={!layoutState.isSidebarExpanded}
										class:active={isItemActive(item)}
										title={!layoutState.isSidebarExpanded ? item.label() : ''}
										onclick={(event) => handleNavClick(event, item.href!)}
									>
										<item.icon
											class="{layoutState.isSidebarExpanded ? 'h-4.5 w-4.5' : 'h-5 w-5'} shrink-0"
										/>
										{#if layoutState.isSidebarExpanded}
											<span class="truncate">{item.label()}</span>
										{/if}
									</a>
								{/if}
							</li>
						{/each}
					</ul>
				</div>

				<!-- Sidebar Footer -->
				<div class="border-t border-base-300 p-2">
					{#if layoutState.isSidebarExpanded}
						<div class="rounded-xl border border-base-300/70 bg-base-100/70 p-2 shadow-sm">
							<div class="flex items-center justify-between px-2 pb-2">
								<span class="text-xs tracking-wide text-base-content/50">{appVersion ?? ''}</span>
								<div class="flex items-center gap-1.5">
									<div class="flex items-center gap-0.5 lg:hidden">
										<a
											href={DISCORD_URL}
											target="_blank"
											rel="noopener noreferrer"
											class="btn btn-ghost px-1 text-base-content/40 btn-xs hover:text-base-content/70"
											title="Discord"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												class="h-3.5 w-3.5"
												viewBox="0 0 24 24"
												fill="currentColor"
											>
												<path
													d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026 13.83 13.83 0 0 0 1.226-1.963.074.074 0 0 0-.041-.104 13.175 13.175 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028z"
												></path>
												<ellipse
													cx="8.5"
													cy="12.5"
													rx="1.5"
													ry="1.65"
													fill="var(--discord-eye, white)"
												></ellipse>
												<ellipse
													cx="15.5"
													cy="12.5"
													rx="1.5"
													ry="1.65"
													fill="var(--discord-eye, white)"
												></ellipse>
											</svg>
										</a>
										<a
											href={GITHUB_URL}
											target="_blank"
											rel="noopener noreferrer"
											class="btn btn-ghost px-1 text-base-content/40 btn-xs hover:text-base-content/70"
											title="GitHub"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												class="h-3.5 w-3.5"
												viewBox="0 0 24 24"
												fill="currentColor"
											>
												<path
													d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"
												></path>
											</svg>
										</a>
									</div>
									<div class="hidden items-center lg:flex">
										{#if layoutState.mobileSseStatus === 'connected'}
											<span class="badge gap-1 badge-xs badge-success">
												<Wifi class="h-3 w-3" />
												{m.common_live()}
											</span>
										{:else if layoutState.mobileSseStatus === 'error'}
											<span class="badge gap-1 badge-xs badge-warning">
												<Loader2 class="h-3 w-3 animate-spin" />
												{m.common_reconnecting()}
											</span>
										{:else if layoutState.mobileSseStatus === 'connecting'}
											<span class="badge gap-1 badge-xs badge-info">
												<Loader2 class="h-3 w-3 animate-spin" />
												{m.common_connecting()}
											</span>
										{/if}
									</div>
								</div>
							</div>
							<div class="space-y-1 border-t border-base-300/70 pt-2">
								<LanguageSelector
									triggerId="sidebar-language-trigger"
									class="dropdown-top w-full"
									showLabel={true}
								/>
								<ThemeSelector
									triggerId="sidebar-theme-trigger"
									class="dropdown-top w-full"
									showLabel={true}
								/>
							</div>
							<div class="mt-2 border-t border-base-300/70 pt-2">
								{#if data.user}
									<a
										href="/profile"
										class="mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-base-200"
										title={m.nav_profile()}
										onclick={closeMobileDrawer}
									>
										<UserAvatar
											name={data.user.displayUsername || data.user.username || '?'}
											src={data.user.image ??
												(data.user.mediaServerId
													? `/api/user/media-server/avatar/${data.user.mediaServerId}`
													: null)}
										/>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm font-medium">
												{data.user.displayUsername || data.user.username}
											</span>
											{#if data.user.sidebarShowUsername && data.user.username}
												<span class="block truncate text-xs text-base-content/50">
													{data.user.username}
												</span>
											{/if}
										</span>
									</a>
								{/if}
								<div class="flex items-center gap-1">
									<button
										class="btn flex-1 justify-start btn-ghost text-error btn-sm hover:bg-error/10"
										onclick={handleLogout}
										disabled={isLoggingOut}
										title={m.action_logout()}
									>
										{#if isLoggingOut}
											<span class="loading loading-xs loading-spinner"></span>
										{:else}
											<LogOut class="h-4 w-4" />
										{/if}
										<span class="ml-2">{m.action_logout()}</span>
									</button>
									<div class="hidden items-center gap-0.5 lg:flex">
										<a
											href={DISCORD_URL}
											target="_blank"
											rel="noopener noreferrer"
											class="btn btn-ghost px-2 text-base-content/40 btn-xs hover:text-base-content/70"
											title="Discord"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												class="h-3.5 w-3.5"
												viewBox="0 0 24 24"
												fill="currentColor"
											>
												<path
													d="M20.317 4.492c-1.53-.69-3.17-1.2-4.885-1.49a.075.075 0 0 0-.079.036c-.21.369-.444.85-.608 1.23a18.566 18.566 0 0 0-5.487 0 12.36 12.36 0 0 0-.617-1.23A.077.077 0 0 0 8.562 3c-1.714.29-3.354.8-4.885 1.491a.07.07 0 0 0-.032.027C.533 9.093-.32 13.555.099 17.961a.08.08 0 0 0 .031.055 20.03 20.03 0 0 0 5.993 2.98.078.078 0 0 0 .084-.026 13.83 13.83 0 0 0 1.226-1.963.074.074 0 0 0-.041-.104 13.175 13.175 0 0 1-1.872-.878.075.075 0 0 1-.008-.125c.126-.093.252-.19.372-.287a.075.075 0 0 1 .078-.01c3.927 1.764 8.18 1.764 12.061 0a.075.075 0 0 1 .079.009c.12.098.245.195.372.288a.075.075 0 0 1-.006.125c-.598.344-1.22.635-1.873.877a.075.075 0 0 0-.041.105c.36.687.772 1.341 1.225 1.962a.077.077 0 0 0 .084.028 19.963 19.963 0 0 0 6.002-2.981.076.076 0 0 0 .032-.054c.5-5.094-.838-9.52-3.549-13.442a.06.06 0 0 0-.031-.028z"
												></path>
												<ellipse
													cx="8.5"
													cy="12.5"
													rx="1.5"
													ry="1.65"
													fill="var(--discord-eye, white)"
												></ellipse>
												<ellipse
													cx="15.5"
													cy="12.5"
													rx="1.5"
													ry="1.65"
													fill="var(--discord-eye, white)"
												></ellipse>
											</svg>
										</a>
										<a
											href={GITHUB_URL}
											target="_blank"
											rel="noopener noreferrer"
											class="btn btn-ghost px-2 text-base-content/40 btn-xs hover:text-base-content/70"
											title="GitHub"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												class="h-3.5 w-3.5"
												viewBox="0 0 24 24"
												fill="currentColor"
											>
												<path
													d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"
												></path>
											</svg>
										</a>
									</div>
								</div>
							</div>
						</div>
					{:else}
						<div
							class="-mx-0.8 w-full rounded-xl border border-base-300/70 bg-base-100/70 p-2 shadow-sm"
						>
							<div class="flex flex-col items-center gap-1">
								<button
									class="btn w-full justify-center btn-ghost btn-sm"
									title={m.ui_selectLanguage()}
									onclick={() => openFooterDropdownOnExpand('language')}
								>
									<Globe class="h-5 w-5" />
								</button>
								<button
									class="btn w-full justify-center btn-ghost btn-sm"
									title={m.ui_selectTheme()}
									onclick={() => openFooterDropdownOnExpand('theme')}
								>
									<Palette class="h-5 w-5" />
								</button>
								<button
									class="btn w-full justify-center btn-ghost text-error btn-sm hover:bg-error/10"
									onclick={handleLogout}
									disabled={isLoggingOut}
									title={m.action_logout()}
								>
									{#if isLoggingOut}
										<span class="loading loading-xs loading-spinner"></span>
									{:else}
										<LogOut class="h-4 w-4" />
									{/if}
								</button>
								{#if layoutState.mobileSseStatus}
									{#if layoutState.mobileSseStatus === 'connected'}
										<span class="badge gap-1 badge-xs badge-success">
											<Wifi class="h-3 w-3" />
										</span>
									{:else if layoutState.mobileSseStatus === 'error'}
										<span class="badge gap-1 badge-xs badge-warning">
											<Loader2 class="h-3 w-3 animate-spin" />
										</span>
									{:else if layoutState.mobileSseStatus === 'connecting'}
										<span class="badge gap-1 badge-xs badge-info">
											<Loader2 class="h-3 w-3 animate-spin" />
										</span>
									{/if}
								{/if}
							</div>
						</div>
					{/if}
				</div>
			</aside>
		</div>
	</div>
{/if}

<!-- Global Toast Notifications -->
<Toasts />
