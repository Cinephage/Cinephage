<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Calendar,
		ChevronLeft,
		ChevronRight,
		X,
		Film,
		Tv,
		Loader2,
		SlidersHorizontal,
		LayoutGrid,
		List,
		Plus,
		Info
	} from '@lucide/svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import AddToLibraryModal from '#lib/components/library/AddToLibraryModal.svelte';
	import type { CalendarDay, CalendarMovieItem } from '#lib/server/calendar/queries.js';
	import type { CalendarPreferences } from '#lib/validation/schemas.js';
	import { getCalendar } from '#lib/api/index.js';
	import { apiPut } from '#lib/api/client.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	let { data } = $props();

	// Preferences are per-account; every signed-in user owns their own.

	let currentMonth = $state('');
	let days = $state<CalendarDay[]>([]);
	let loading = $state(false);
	let showPreferences = $state(false);
	let savingPrefs = $state(false);

	const ALL_CERTIFICATIONS = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'];

	let prefs = $state<CalendarPreferences>({
		contentType: 'all',
		libraryOnly: false,
		upcomingShowNonLibrary: true,
		viewMode: 'grid',
		minRating: 0,
		genreIds: [],
		excludeAdult: false,
		certifications: []
	});

	// Add to Library modal state
	let addModalOpen = $state(false);
	let modalMovie = $state<CalendarMovieItem | null>(null);

	interface Genre {
		id: number;
		name: string;
	}
	let genres = $state<Genre[]>([]);

	$effect(() => {
		const snap = $state.snapshot(data);
		currentMonth = snap.currentMonth;
		days = snap.days as CalendarDay[];
		prefs = snap.preferences as CalendarPreferences;
		genres = (snap.genres ?? []) as Genre[];
	});

	let selectedDay = $state<CalendarDay | null>(null);
	let abortController = $state<AbortController | null>(null);

	const currentLocale = getLocale();
	const dayNames = [...Array(7)].map((_, i) => {
		const d = new Date(2024, 0, 7 + i);
		return d.toLocaleDateString(currentLocale, { weekday: 'short' });
	});

	const todayMonth = (() => {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	})();

	const isCurrentMonth = $derived(currentMonth === todayMonth);

	// Days with items in the current month only, sorted, for the agenda view
	const agendaDays = $derived(
		days
			.filter(
				(d) => d.date.startsWith(currentMonth) && (d.movies.length > 0 || d.episodes.length > 0)
			)
			.sort((a, b) => a.date.localeCompare(b.date))
	);

	interface GridCell {
		date: string;
		dayOfMonth: number;
		isCurrentMonth: boolean;
		isToday: boolean;
		items: CalendarDay | null;
	}

	const monthGrid = $derived.by(() => {
		const [year, month] = currentMonth.split('-').map(Number);
		const firstDay = new Date(year, month - 1, 1);
		const lastDay = new Date(year, month, 0);
		const startDow = firstDay.getDay();
		const daysInMonth = lastDay.getDate();

		const today = new Date();
		const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

		const dayMap = new SvelteMap<string, CalendarDay>();
		for (const d of days) {
			dayMap.set(d.date, d);
		}

		const prevMonthLast = new Date(year, month - 1, 0).getDate();
		const weeks: GridCell[][] = [];
		let week: GridCell[] = [];

		for (let i = startDow - 1; i >= 0; i--) {
			const dom = prevMonthLast - i;
			const mo = month - 1 < 1 ? 12 : month - 1;
			const y = month - 1 < 1 ? year - 1 : year;
			const dateStr = `${y}-${String(mo).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
			week.push({
				date: dateStr,
				dayOfMonth: dom,
				isCurrentMonth: false,
				isToday: dateStr === todayStr,
				items: dayMap.get(dateStr) ?? null
			});
		}

		for (let dom = 1; dom <= daysInMonth; dom++) {
			const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
			week.push({
				date: dateStr,
				dayOfMonth: dom,
				isCurrentMonth: true,
				isToday: dateStr === todayStr,
				items: dayMap.get(dateStr) ?? null
			});
			if (week.length === 7) {
				weeks.push(week);
				week = [];
			}
		}

		let nextDom = 1;
		while (week.length < 7) {
			const mo = month + 1 > 12 ? 1 : month + 1;
			const y = month + 1 > 12 ? year + 1 : year;
			const dateStr = `${y}-${String(mo).padStart(2, '0')}-${String(nextDom).padStart(2, '0')}`;
			week.push({
				date: dateStr,
				dayOfMonth: nextDom,
				isCurrentMonth: false,
				isToday: dateStr === todayStr,
				items: dayMap.get(dateStr) ?? null
			});
			nextDom++;
		}
		weeks.push(week);

		return weeks;
	});

	const monthLabel = $derived.by(() => {
		const [year, month] = currentMonth.split('-').map(Number);
		const d = new Date(year, month - 1, 1);
		return d.toLocaleDateString(currentLocale, { month: 'long', year: 'numeric' });
	});

	function fetchCalendar(month: string) {
		loading = true;
		selectedDay = null;
		if (abortController) abortController.abort();
		const controller = new AbortController();
		abortController = controller;
		getCalendar(
			month,
			prefs.contentType,
			prefs.libraryOnly,
			prefs.minRating,
			prefs.genreIds,
			prefs.excludeAdult,
			prefs.certifications
		)
			.then((result) => {
				if (controller.signal.aborted) return;
				days = result as unknown as CalendarDay[];
				loading = false;
			})
			.catch((err) => {
				if (err instanceof DOMException && err.name === 'AbortError') return;
				loading = false;
			});
	}

	function goToMonth(offset: number) {
		const [y, mo] = currentMonth.split('-').map(Number);
		const d = new Date(y, mo - 1 + offset, 1);
		currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		fetchCalendar(currentMonth);
	}

	function goToToday() {
		currentMonth = todayMonth;
		fetchCalendar(currentMonth);
	}

	async function toggleViewMode() {
		prefs.viewMode = prefs.viewMode === 'grid' ? 'list' : 'grid';
		try {
			await apiPut('/api/user/preferences/calendar', { value: { ...prefs } });
		} catch {
			// non-critical — view still works locally
		}
	}

	async function savePreferences() {
		savingPrefs = true;
		try {
			await apiPut('/api/user/preferences/calendar', { value: { ...prefs } });
			fetchCalendar(currentMonth);
			toasts.success('Calendar preferences saved');
		} catch {
			toasts.error('Failed to save calendar preferences');
		} finally {
			savingPrefs = false;
		}
	}

	function openAddModal(movie: CalendarMovieItem) {
		modalMovie = movie;
		addModalOpen = true;
	}

	function handleAddSuccess() {
		addModalOpen = false;
		modalMovie = null;
		fetchCalendar(currentMonth);
	}

	function openDay(cell: GridCell) {
		if (!cell.items) return;
		if (cell.items.movies.length === 0 && cell.items.episodes.length === 0) return;
		selectedDay = cell.items;
	}

	function closePanel() {
		selectedDay = null;
	}

	function formatPanelDate(dateStr: string): string {
		const d = new Date(dateStr + 'T00:00:00');
		return d.toLocaleDateString(currentLocale, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});
	}

	function formatAgendaDate(dateStr: string): string {
		const d = new Date(dateStr + 'T00:00:00');
		return d.toLocaleDateString(currentLocale, { weekday: 'long', month: 'long', day: 'numeric' });
	}

	function movieYear(releaseDate: string): number {
		return parseInt(releaseDate.split('-')[0]);
	}
</script>

<svelte:head>
	<title>{m.nav_calendar()}</title>
</svelte:head>

<div class="bg-base-100">
	<div class="space-y-4 px-4 py-6 lg:px-8">
		<!-- Header: title row + nav row (stacked on mobile, single row on sm+) -->
		<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
			<!-- Title + action icons -->
			<div class="flex items-center justify-between sm:justify-start sm:gap-2">
				<h1 class="flex items-center gap-2 text-2xl font-bold">
					<Calendar class="h-7 w-7 sm:h-8 sm:w-8" />
					{m.nav_calendar()}
				</h1>
				<!-- On mobile these sit on the title row; hidden on sm+ where they move to nav row -->
				<div class="flex items-center gap-1 sm:hidden">
					<button
						class="btn btn-circle btn-ghost btn-xs"
						onclick={toggleViewMode}
						aria-label={prefs.viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
					>
						{#if prefs.viewMode === 'grid'}
							<List class="h-4 w-4" />
						{:else}
							<LayoutGrid class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-circle btn-ghost btn-xs {showPreferences ? 'bg-base-300' : ''}"
						onclick={() => (showPreferences = !showPreferences)}
						aria-label="Calendar preferences"
					>
						<SlidersHorizontal class="h-4 w-4" />
					</button>
				</div>
			</div>

			<!-- Nav row -->
			<div class="flex items-center gap-1 sm:gap-2">
				{#if !isCurrentMonth}
					<button class="btn btn-ghost btn-xs sm:btn-sm" onclick={goToToday}>
						{m.calendar_today()}
					</button>
				{/if}

				<div class="flex flex-1 items-center justify-center gap-1 sm:flex-none sm:gap-2">
					<button class="btn btn-circle btn-ghost btn-xs sm:btn-sm" onclick={() => goToMonth(-1)}>
						<ChevronLeft class="h-4 w-4 sm:h-5 sm:w-5" />
					</button>
					<span class="w-36 text-center text-base font-semibold sm:w-auto sm:min-w-45 sm:text-lg"
						>{monthLabel}</span
					>
					<button class="btn btn-circle btn-ghost btn-xs sm:btn-sm" onclick={() => goToMonth(1)}>
						<ChevronRight class="h-4 w-4 sm:h-5 sm:w-5" />
					</button>
				</div>

				<!-- Hidden on mobile (shown in title row instead) -->
				<div class="hidden items-center gap-2 sm:flex">
					<button
						class="btn btn-circle btn-ghost btn-sm"
						onclick={toggleViewMode}
						aria-label={prefs.viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
					>
						{#if prefs.viewMode === 'grid'}
							<List class="h-5 w-5" />
						{:else}
							<LayoutGrid class="h-5 w-5" />
						{/if}
					</button>
					<button
						class="btn btn-circle btn-ghost btn-sm {showPreferences ? 'bg-base-300' : ''}"
						onclick={() => (showPreferences = !showPreferences)}
						aria-label="Calendar preferences"
					>
						<SlidersHorizontal class="h-5 w-5" />
					</button>
				</div>
			</div>
		</div>

		<!-- Preferences panel -->
		{#if showPreferences}
			<div class="space-y-4 rounded-xl border border-base-300 bg-base-200 p-4">
				<!-- Row 1: Show type + option toggles -->
				<div class="flex flex-wrap items-start gap-x-8 gap-y-3">
					<div class="space-y-1.5">
						<p class="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
							{m.calendar_prefs_show()}
						</p>
						<div class="join">
							<button
								class="btn join-item btn-xs sm:btn-sm {prefs.contentType === 'all'
									? 'btn-primary'
									: 'border border-base-300 btn-ghost'}"
								onclick={() => (prefs.contentType = 'all')}
							>
								{m.calendar_prefs_all()}
							</button>
							<button
								class="btn join-item btn-xs sm:btn-sm {prefs.contentType === 'movies'
									? 'btn-primary'
									: 'border border-base-300 btn-ghost'}"
								onclick={() => (prefs.contentType = 'movies')}
							>
								{m.common_movies()}
							</button>
							<button
								class="btn join-item btn-xs sm:btn-sm {prefs.contentType === 'episodes'
									? 'btn-primary'
									: 'border border-base-300 btn-ghost'}"
								onclick={() => (prefs.contentType = 'episodes')}
							>
								{m.common_episodes()}
							</button>
						</div>
					</div>

					<div class="space-y-1.5">
						<p class="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
							{m.calendar_prefs_options()}
						</p>
						<div class="flex flex-col gap-2">
							{#if prefs.contentType !== 'episodes'}
								<label class="flex cursor-pointer items-center gap-3">
									<input
										type="checkbox"
										class="toggle toggle-primary toggle-sm"
										bind:checked={prefs.libraryOnly}
									/>
									<span class="text-sm">{m.calendar_prefs_libraryOnly()}</span>
								</label>
							{/if}
							<label class="flex cursor-pointer items-center gap-3">
								<input
									type="checkbox"
									class="toggle toggle-primary toggle-sm"
									bind:checked={prefs.upcomingShowNonLibrary}
								/>
								<span class="text-sm">{m.calendar_prefs_upcomingNonLibrary()}</span>
							</label>
						</div>
					</div>
				</div>

				<!-- Row 2: Non-library filters (only when relevant) -->
				{#if !prefs.libraryOnly && prefs.contentType !== 'episodes'}
					<div class="space-y-3 border-t border-base-300 pt-4">
						<!-- Rating + Content row -->
						<div class="flex flex-wrap items-start gap-x-8 gap-y-3">
							<div class="space-y-1.5">
								<p class="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
									{m.calendar_prefs_minRating()}
								</p>
								<div class="join">
									{#each [0, 6, 7, 8] as rating (rating)}
										<button
											class="btn join-item btn-xs sm:btn-sm {prefs.minRating === rating
												? 'btn-primary'
												: 'border border-base-300 btn-ghost'}"
											onclick={() => (prefs.minRating = rating)}
										>
											{rating === 0 ? m.calendar_prefs_anyRating() : `${rating}+`}
										</button>
									{/each}
								</div>
							</div>

							<div class="space-y-1.5">
								<p class="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
									{m.calendar_prefs_contentRating()}
								</p>
								<div class="flex flex-wrap items-center gap-1.5">
									<button
										class="badge cursor-pointer badge-sm select-none {prefs.certifications
											.length === 0
											? 'badge-primary'
											: 'border badge-ghost border-base-300'}"
										onclick={() => (prefs.certifications = [])}
									>
										{m.calendar_prefs_allRatings()}
									</button>
									{#each ALL_CERTIFICATIONS as cert (cert)}
										{@const selected = prefs.certifications.includes(cert)}
										<button
											class="badge cursor-pointer font-mono badge-sm select-none {selected
												? 'badge-primary'
												: 'border badge-ghost border-base-300'}"
											onclick={() => {
												if (selected) {
													prefs.certifications = prefs.certifications.filter((c) => c !== cert);
												} else {
													prefs.certifications = [...prefs.certifications, cert];
												}
											}}
										>
											{cert}
										</button>
									{/each}
									<label class="ml-2 flex cursor-pointer items-center gap-2">
										<input
											type="checkbox"
											class="toggle toggle-primary toggle-xs"
											bind:checked={prefs.excludeAdult}
										/>
										<span class="text-xs text-base-content/60"
											>{m.calendar_prefs_excludeAdult()}</span
										>
									</label>
								</div>
							</div>
						</div>

						<!-- Genres -->
						{#if genres.length > 0}
							<div class="space-y-1.5">
								<p class="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
									{m.calendar_prefs_genres()}
								</p>
								<div class="flex flex-wrap gap-1.5">
									<button
										class="badge cursor-pointer badge-sm select-none {prefs.genreIds.length === 0
											? 'badge-primary'
											: 'border badge-ghost border-base-300'}"
										onclick={() => (prefs.genreIds = [])}
									>
										{m.calendar_prefs_allGenres()}
									</button>
									{#each genres as genre (genre.id)}
										{@const selected = prefs.genreIds.includes(genre.id)}
										<button
											class="badge cursor-pointer badge-sm select-none {selected
												? 'badge-primary'
												: 'border badge-ghost border-base-300'}"
											onclick={() => {
												if (selected) {
													prefs.genreIds = prefs.genreIds.filter((id) => id !== genre.id);
												} else {
													prefs.genreIds = [...prefs.genreIds, genre.id];
												}
											}}
										>
											{genre.name}
										</button>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Save -->
				<div class="flex justify-end border-t border-base-300 pt-3">
					<button class="btn btn-primary btn-sm" onclick={savePreferences} disabled={savingPrefs}>
						{savingPrefs ? m.common_saving() : m.action_save()}
					</button>
				</div>
			</div>
		{/if}

		<div
			class="flex items-start gap-2 rounded-lg bg-base-200 px-3 py-2 text-sm text-base-content/50"
		>
			<Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<p>
				TV series must be in your library and monitored for upcoming episodes to appear here. Movies
				can optionally include upcoming releases outside your library.
			</p>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="h-8 w-8 animate-spin" />
			</div>
		{:else if prefs.viewMode === 'grid'}
			<!-- Grid view -->
			<div class="overflow-hidden rounded-xl border border-base-300">
				<!-- Day name headers -->
				<div class="grid grid-cols-7 border-b border-base-300 bg-base-100">
					{#each dayNames as name, i (i)}
						<div class="px-1 py-2.5 text-center text-xs font-medium text-base-content/40">
							{name}
						</div>
					{/each}
				</div>

				<!-- Week rows -->
				<div class="divide-y divide-base-200">
					{#each monthGrid as week, _wi (_wi)}
						<div class="grid grid-cols-7 divide-x divide-base-200">
							{#each week as cell (cell.date)}
								{@const movieCount = cell.items?.movies.length ?? 0}
								{@const episodeCount = cell.items?.episodes.length ?? 0}
								{@const totalItems = movieCount + episodeCount}
								{@const hasItems = totalItems > 0}
								<button
									class="min-h-20 p-2 text-left transition-colors sm:min-h-28 sm:p-3
										{cell.isToday
										? 'bg-primary/5 hover:bg-primary/10'
										: cell.isCurrentMonth
											? 'bg-base-100 hover:bg-base-200/60'
											: 'bg-base-200/40 hover:bg-base-200/70'}"
									onclick={() => openDay(cell)}
									disabled={!hasItems}
								>
									<!-- Day number — separate elements avoids class conflicts -->
									{#if cell.isToday}
										<div
											class="mb-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-content"
										>
											{cell.dayOfMonth}
										</div>
									{:else}
										<div
											class="mb-1.5 text-xs font-medium sm:text-sm
											{cell.isCurrentMonth ? 'text-base-content' : 'text-base-content/20'}"
										>
											{cell.dayOfMonth}
										</div>
									{/if}

									<!-- Mobile: colored dots — solid = in library, faded = not in library -->
									<div class="flex flex-wrap gap-0.5 sm:hidden">
										{#each (cell.items?.movies ?? []).slice(0, 3) as movie (movie.tmdbId)}
											<span
												class="h-1.5 w-1.5 rounded-full {movie.inLibrary
													? 'bg-primary'
													: 'bg-primary/30'}"
											></span>
										{/each}
										{#each (cell.items?.episodes ?? []).slice(0, Math.max(0, 3 - movieCount)) as ep (ep.episodeId)}
											<span class="h-1.5 w-1.5 rounded-full bg-secondary"></span>
										{/each}
										{#if totalItems > 3}
											<span class="h-1.5 w-1.5 rounded-full bg-base-content/20"></span>
										{/if}
									</div>

									<!-- Desktop: text chips — filled = in library, outline = not in library -->
									<div class="hidden space-y-0.5 sm:block">
										{#each (cell.items?.movies ?? []).slice(0, 2) as movie (movie.tmdbId)}
											<div
												class="truncate rounded-full px-1.5 py-0.5 text-[10px] font-semibold
												{movie.inLibrary
													? 'bg-primary/15 text-primary'
													: 'text-primary/60 ring-1 ring-primary/40 ring-inset'}"
											>
												{movie.title}
											</div>
										{/each}
										{#each (cell.items?.episodes ?? []).slice(0, 2 - Math.min(movieCount, 2)) as ep (ep.episodeId)}
											<div
												class="truncate rounded-full bg-secondary/15 px-1.5 py-0.5 text-[10px] font-semibold text-secondary"
											>
												S{String(ep.seasonNumber).padStart(2, '0')}E{String(
													ep.episodeNumber
												).padStart(2, '0')}
												{ep.seriesTitle}
											</div>
										{/each}
										{#if totalItems > Math.min(movieCount, 2) + Math.min(episodeCount, 2 - Math.min(movieCount, 2))}
											<div class="px-1 text-[10px] text-base-content/40">
												{m.calendar_more({
													count:
														totalItems -
														(Math.min(movieCount, 2) +
															Math.min(episodeCount, 2 - Math.min(movieCount, 2)))
												})}
											</div>
										{/if}
									</div>
								</button>
							{/each}
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<!-- Agenda / list view -->
			{#if agendaDays.length === 0}
				<div class="py-16 text-center text-base-content/50">
					{m.calendar_noUpcoming()}
				</div>
			{:else}
				<div class="space-y-6">
					{#each agendaDays as day (day.date)}
						<div>
							<h2 class="mb-3 text-sm font-bold tracking-wide text-base-content/60 uppercase">
								{formatAgendaDate(day.date)}
							</h2>
							<div class="space-y-2">
								{#each day.movies as movie (movie.tmdbId)}
									<div
										class="flex min-h-14 items-center gap-3 rounded-xl border border-base-300 bg-base-200 p-3"
									>
										<a
											href={movie.inLibrary && movie.movieId
												? `/library/movie/${movie.movieId}`
												: `/discover/movie/${movie.tmdbId}`}
											class="h-16 w-10 shrink-0 overflow-hidden rounded"
										>
											<TmdbImage
												path={movie.posterPath}
												size="w92"
												alt={movie.title}
												class="h-16 w-10 object-cover"
											/>
										</a>
										<div class="min-w-0 flex-1">
											<a
												href={movie.inLibrary && movie.movieId
													? `/library/movie/${movie.movieId}`
													: `/discover/movie/${movie.tmdbId}`}
												class="block truncate text-sm font-semibold hover:underline"
											>
												{movie.title}
											</a>
											<div class="mt-1 flex items-center gap-1.5">
												<Film class="h-3 w-3 text-primary/50" />
												<span class="text-xs text-primary/50">{m.common_movie()}</span>
											</div>
										</div>
										{#if movie.inLibrary}
											<span class="badge shrink-0 badge-sm badge-primary"
												>{m.calendar_inLibrary()}</span
											>
										{:else}
											<button
												class="btn shrink-0 gap-1 btn-ghost btn-xs"
												onclick={() => openAddModal(movie)}
											>
												<Plus class="h-3.5 w-3.5" />
												<span class="hidden sm:inline">{m.calendar_addToLibrary()}</span>
												<span class="sm:hidden">{m.action_add()}</span>
											</button>
										{/if}
									</div>
								{/each}

								{#each day.episodes as ep (ep.episodeId)}
									<a
										href="/library/tv/{ep.seriesId}"
										class="flex min-h-14 items-center gap-3 rounded-xl border border-base-300 bg-base-200 p-3 transition-colors hover:bg-base-300"
									>
										<div class="h-16 w-10 shrink-0 overflow-hidden rounded">
											<TmdbImage
												path={ep.seriesPosterPath}
												size="w92"
												alt={ep.seriesTitle}
												class="h-16 w-10 object-cover"
											/>
										</div>
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm font-semibold">{ep.seriesTitle}</p>
											<div class="mt-0.5 flex items-center gap-1.5">
												<Tv class="h-3 w-3 text-secondary/60" />
												<span class="text-xs text-secondary/60">
													S{String(ep.seasonNumber).padStart(2, '0')}E{String(
														ep.episodeNumber
													).padStart(2, '0')}{ep.title ? ` — ${ep.title}` : ''}
												</span>
											</div>
										</div>
										<span class="badge shrink-0 badge-sm badge-secondary"
											>{m.calendar_inLibrary()}</span
										>
									</a>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<!-- Day detail panel (grid view) -->
{#if selectedDay}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40 bg-black/40"
		onclick={closePanel}
		onkeydown={(e) => e.key === 'Escape' && closePanel()}
	></div>

	<div
		class="fixed top-0 right-0 z-50 flex h-full w-full flex-col overflow-y-auto bg-base-100 shadow-2xl sm:max-w-md"
	>
		<div
			class="sticky top-0 z-10 flex items-center justify-between border-b border-base-200 bg-base-100 px-4 py-3"
		>
			<h2 class="text-lg font-bold">{formatPanelDate(selectedDay.date)}</h2>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={closePanel}>
				<X class="h-5 w-5" />
			</button>
		</div>

		<div class="space-y-4 p-4">
			{#if selectedDay.movies.length > 0}
				<div>
					<h3
						class="mb-2 flex items-center gap-2 text-sm font-bold tracking-wide text-base-content/70 uppercase"
					>
						<Film class="h-4 w-4 text-primary" />
						{m.common_movies()}
					</h3>
					<div class="space-y-2">
						{#each selectedDay.movies as movie (movie.tmdbId)}
							<div class="flex items-center gap-3 rounded-lg bg-base-200 p-3">
								<a
									href={movie.inLibrary && movie.movieId
										? `/library/movie/${movie.movieId}`
										: `/discover/movie/${movie.tmdbId}`}
									class="h-16 w-10 shrink-0 overflow-hidden rounded"
								>
									<TmdbImage
										path={movie.posterPath}
										size="w92"
										alt={movie.title}
										class="h-16 w-10"
									/>
								</a>
								<div class="min-w-0 flex-1">
									<a
										href={movie.inLibrary && movie.movieId
											? `/library/movie/${movie.movieId}`
											: `/discover/movie/${movie.tmdbId}`}
										class="block truncate text-sm font-medium hover:underline"
									>
										{movie.title}
									</a>
									<div class="mt-1">
										{#if movie.inLibrary}
											<span class="badge badge-sm badge-primary">{m.calendar_inLibrary()}</span>
										{:else}
											<button
												class="btn gap-1 btn-ghost px-2 btn-xs"
												onclick={() => openAddModal(movie)}
											>
												<Plus class="h-3.5 w-3.5" />
												{m.calendar_addToLibrary()}
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if selectedDay.episodes.length > 0}
				<div>
					<h3
						class="mb-2 flex items-center gap-2 text-sm font-bold tracking-wide text-base-content/70 uppercase"
					>
						<Tv class="h-4 w-4 text-secondary" />
						{m.common_episodes()}
					</h3>
					<div class="space-y-2">
						{#each selectedDay.episodes as ep (ep.episodeId)}
							<a
								href="/library/tv/{ep.seriesId}"
								class="flex items-center gap-3 rounded-lg bg-base-200 p-3 transition-colors hover:bg-base-300"
							>
								<div class="h-16 w-10 shrink-0 overflow-hidden rounded">
									<TmdbImage
										path={ep.seriesPosterPath}
										size="w92"
										alt={ep.seriesTitle}
										class="h-16 w-10"
									/>
								</div>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium">{ep.seriesTitle}</div>
									<div class="text-xs text-base-content/60">
										S{String(ep.seasonNumber).padStart(2, '0')}E{String(ep.episodeNumber).padStart(
											2,
											'0'
										)}
										{#if ep.title}
											- {ep.title}
										{/if}
									</div>
								</div>
							</a>
						{/each}
					</div>
				</div>
			{/if}

			{#if selectedDay.movies.length === 0 && selectedDay.episodes.length === 0}
				<div class="py-8 text-center text-base-content/50">
					{m.calendar_noUpcoming()}
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- Add to Library modal -->
{#if modalMovie}
	<AddToLibraryModal
		open={addModalOpen}
		mediaType="movie"
		tmdbId={modalMovie.tmdbId}
		title={modalMovie.title}
		year={movieYear(modalMovie.releaseDate)}
		posterPath={modalMovie.posterPath}
		onClose={() => {
			addModalOpen = false;
			modalMovie = null;
		}}
		onSuccess={handleAddSuccess}
	/>
{/if}
