<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import {
		Tv,
		ChevronLeft,
		ChevronRight,
		Clock,
		Calendar,
		Loader2,
		X,
		Search
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { ChannelLineupItemWithDetails, EpgProgram } from '#lib/types/livetv.js';
	import { onMount } from 'svelte';
	import {
		getEpgGuide,
		getStoredEpgDisplayLanguage,
		storeEpgDisplayLanguage
	} from '#lib/api/livetv.js';
	import { ALL_LANGUAGE_OPTIONS } from '#lib/shared/languages.js';
	import { getEpgConfig } from './epgConfig';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { formatDisplayDate, toDateString } from '#lib/utils/format.js';

	interface Props {
		lineup: ChannelLineupItemWithDetails[];
		loading: boolean;
	}

	let { lineup, loading }: Props = $props();

	// EPG display language (localStorage-persisted). Empty = auto: the server
	// uses the instance metadata locale (language_settings.metadata_locale).
	let displayLanguage = $state(getStoredEpgDisplayLanguage());

	function handleDisplayLanguageChange(event: Event) {
		displayLanguage = (event.currentTarget as HTMLSelectElement).value;
		storeEpgDisplayLanguage(displayLanguage);
	}

	// Viewport width tracking for responsive config
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	const gridConfig = $derived(getEpgConfig(viewportWidth));

	// Reactive grid configuration from breakpoint config
	const CHANNEL_WIDTH = $derived(gridConfig.channelWidth);
	const HOUR_WIDTH = $derived(gridConfig.hourWidth);
	const ROW_HEIGHT = $derived(gridConfig.rowHeight);
	const SLOT_MINUTES = $derived(gridConfig.slotMinutes);
	const SLOT_WIDTH = $derived((HOUR_WIDTH * SLOT_MINUTES) / 60);
	const CHANNEL_COLUMN_WIDTH = $derived(Math.max(CHANNEL_WIDTH, 124));

	// Time/day state
	const DAY_MS = 24 * 60 * 60 * 1000;
	const WINDOW_HOURS = 24;
	let dayOffset = $state(0);
	let nowTime = $state(Date.now());
	let now = $derived(new Date(nowTime));
	const todayStartTime = $derived(getDayStartTime(nowTime));
	const windowStartTime = $derived(todayStartTime + dayOffset * DAY_MS);
	const windowStart = $derived(new Date(windowStartTime));
	const windowEnd = $derived(new Date(windowStartTime + WINDOW_HOURS * 60 * 60 * 1000));

	// Program data
	let programsByChannel = new SvelteMap<string, EpgProgram[]>();
	let loadingPrograms = $state(false);
	let loadProgramsRequestId = 0;
	let channelSearch = $state('');
	let gridViewportEl = $state<HTMLDivElement | null>(null);
	let viewportScrollTop = $state(0);
	let viewportHeight = $state(0);

	const HEADER_HEIGHT = 40;
	const VIRTUAL_BUFFER_ROWS = 8;
	const VISIBLE_CHANNEL_ROWS = 9;
	const ROW_TOTAL_HEIGHT = $derived(ROW_HEIGHT);
	const viewportContainerHeight = $derived(HEADER_HEIGHT + ROW_TOTAL_HEIGHT * VISIBLE_CHANNEL_ROWS);

	const normalizedSearch = $derived(channelSearch.trim().toLowerCase());
	const filteredLineup = $derived(
		normalizedSearch
			? lineup.filter((channel) => {
					const name = channel.displayName.toLowerCase();
					const account = channel.accountName.toLowerCase();
					const number = channel.channelNumber?.toString() ?? '';
					return (
						name.includes(normalizedSearch) ||
						account.includes(normalizedSearch) ||
						number.includes(normalizedSearch)
					);
				})
			: lineup
	);
	const visibleRowCount = $derived(
		Math.max(1, Math.ceil(Math.max(0, viewportHeight - HEADER_HEIGHT) / ROW_TOTAL_HEIGHT))
	);
	const virtualStartIndex = $derived(
		Math.max(
			0,
			Math.floor(Math.max(0, viewportScrollTop - HEADER_HEIGHT) / ROW_TOTAL_HEIGHT) -
				VIRTUAL_BUFFER_ROWS
		)
	);
	const virtualEndIndex = $derived(
		Math.min(filteredLineup.length, virtualStartIndex + visibleRowCount + VIRTUAL_BUFFER_ROWS * 2)
	);
	const visibleChannels = $derived(filteredLineup.slice(virtualStartIndex, virtualEndIndex));
	const totalRowsHeight = $derived(
		Math.max(ROW_TOTAL_HEIGHT, filteredLineup.length * ROW_TOTAL_HEIGHT)
	);
	const isViewingToday = $derived(dayOffset === 0);
	let timeInterval: ReturnType<typeof setInterval> | null = null;

	// Selected program for details
	let selectedProgram = $state<{
		program: EpgProgram;
		channel: ChannelLineupItemWithDetails;
	} | null>(null);

	function getDayStartTime(time: number): number {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- pure utility function
		const d = new Date(time);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	// Generate time slots for the header
	const timeSlots = $derived.by(() => {
		const slots: number[] = [];
		let current = windowStartTime;
		const end = windowStartTime + WINDOW_HOURS * 60 * 60 * 1000;
		while (current < end) {
			slots.push(current);
			current += SLOT_MINUTES * 60 * 1000;
		}
		return slots;
	});

	// Grid width based on time window
	const gridWidth = $derived(
		((windowEnd.getTime() - windowStart.getTime()) / 3600000) * HOUR_WIDTH
	);

	// Current time indicator position relative to timeline origin
	const nowTimelineOffset = $derived.by(() => {
		const elapsed = (now.getTime() - windowStart.getTime()) / 3600000;
		if (elapsed < 0 || elapsed > WINDOW_HOURS) return null;
		const safeEdge = Math.min(2, Math.max(0, gridWidth / 2));
		return Math.min(gridWidth - safeEdge, Math.max(safeEdge, elapsed * HOUR_WIDTH));
	});

	onMount(() => {
		timeInterval = setInterval(() => {
			nowTime = Date.now();
		}, 60000); // Update every minute

		// Track viewport width for responsive config
		function handleResize() {
			viewportWidth = window.innerWidth;
		}
		window.addEventListener('resize', handleResize);

		return () => {
			window.removeEventListener('resize', handleResize);
			if (timeInterval) {
				clearInterval(timeInterval);
			}
		};
	});

	// Reload programs when time window, lineup, or display language changes
	$effect(() => {
		// Dependencies: window, lineup, display language
		void windowStartTime;
		void lineup;
		void displayLanguage;
		loadPrograms();
	});

	$effect(() => {
		if (!gridViewportEl) return;
		const el = gridViewportEl;
		viewportHeight = el.clientHeight;
		viewportScrollTop = el.scrollTop;
		const observer = new ResizeObserver(() => {
			viewportHeight = el.clientHeight;
		});
		observer.observe(el);
		return () => observer.disconnect();
	});

	$effect(() => {
		// Reset vertical position on day/search changes and align horizontal position
		void dayOffset;
		void normalizedSearch;
		if (!gridViewportEl) return;
		gridViewportEl.scrollTop = 0;
		viewportScrollTop = 0;

		if (dayOffset !== 0) {
			gridViewportEl.scrollLeft = 0;
			return;
		}

		scrollToCurrentTime();
	});

	async function loadPrograms() {
		const requestId = ++loadProgramsRequestId;

		if (lineup.length === 0) {
			programsByChannel.clear();
			loadingPrograms = false;
			return;
		}

		loadingPrograms = true;
		try {
			const channelIds = lineup.map((ch) => ch.epgSourceChannelId ?? ch.channelId);
			const data = await getEpgGuide({
				start: windowStart.toISOString(),
				end: windowEnd.toISOString(),
				channelIds: channelIds.join(','),
				...(displayLanguage ? { lang: displayLanguage } : {})
			});

			if (requestId !== loadProgramsRequestId) {
				return;
			}

			programsByChannel.clear();

			// Map the programs back to lineup item IDs
			for (const item of lineup) {
				const sourceChannelId = item.epgSourceChannelId ?? item.channelId;
				programsByChannel.set(item.id, data.programs[sourceChannelId] || []);
			}
		} catch {
			// Silent failure
		} finally {
			if (requestId === loadProgramsRequestId) {
				loadingPrograms = false;
			}
		}
	}

	function formatTime(date: Date): string {
		return new Intl.DateTimeFormat(getLocale(), { hour: 'numeric', minute: '2-digit' }).format(
			date
		);
	}

	function formatLongDate(date: Date): string {
		return formatDisplayDate(toDateString(date), {
			weekday: 'long'
		});
	}

	function navigatePrev() {
		dayOffset -= 1;
	}

	function navigateNext() {
		dayOffset += 1;
	}

	function jumpToNow() {
		if (!isViewingToday) {
			dayOffset = 0;
			return;
		}

		scrollToCurrentTime();
	}

	function scrollToCurrentTime() {
		if (!gridViewportEl) return;
		const nowHourOffset = Math.max(0, (now.getTime() - windowStart.getTime()) / 3600000);
		const visibleTimelineWidth = gridViewportEl.clientWidth - CHANNEL_COLUMN_WIDTH;
		const targetLeft = Math.max(0, nowHourOffset * HOUR_WIDTH - visibleTimelineWidth / 2);
		gridViewportEl.scrollLeft = targetLeft;
	}

	function handleGridScroll(e: Event) {
		const target = e.currentTarget as HTMLDivElement;
		viewportScrollTop = target.scrollTop;
	}

	function getProgramStyle(program: EpgProgram): string {
		const start = new Date(program.startTime);
		const end = new Date(program.endTime);

		// Clamp to window bounds
		const clampedStart = Math.max(start.getTime(), windowStart.getTime());
		const clampedEnd = Math.min(end.getTime(), windowEnd.getTime());

		const leftOffset = ((clampedStart - windowStart.getTime()) / 3600000) * HOUR_WIDTH;
		const width = ((clampedEnd - clampedStart) / 3600000) * HOUR_WIDTH;

		return `left: ${leftOffset}px; width: ${Math.max(width - 2, 20)}px;`;
	}

	function isCurrentlyAiring(program: EpgProgram): boolean {
		const start = new Date(program.startTime).getTime();
		const end = new Date(program.endTime).getTime();
		const nowTime = now.getTime();
		return nowTime >= start && nowTime < end;
	}

	function showProgramDetails(program: EpgProgram, channel: ChannelLineupItemWithDetails) {
		selectedProgram = { program, channel };
	}

	function closeProgramDetails() {
		selectedProgram = null;
	}
</script>

<div class="space-y-4">
	<!-- Navigation header -->
	<div class="flex flex-col items-center gap-2">
		<div class="flex w-full items-center justify-between">
			<button class="btn gap-1 btn-outline px-3 btn-sm" onclick={navigatePrev}>
				<ChevronLeft class="h-4 w-4" />
				<span class="hidden sm:inline">{m.livetv_epgGuide_previous()}</span>
				<span class="sm:hidden">{m.livetv_epgGuide_prev()}</span>
			</button>
			<div class="text-center text-sm font-semibold text-base-content/80">
				{formatLongDate(windowStart)}
			</div>
			<button class="btn gap-1 btn-outline px-3 btn-sm" onclick={navigateNext}>
				<span>{m.livetv_epgGuide_next()}</span>
				<ChevronRight class="h-4 w-4" />
			</button>
		</div>
		<button class="btn gap-1 px-4 btn-primary btn-sm" onclick={jumpToNow}>
			{#if isViewingToday}
				<Clock class="h-4 w-4" />
			{:else}
				<Calendar class="h-4 w-4" />
			{/if}
			<span>{isViewingToday ? m.livetv_epgGuide_now() : m.livetv_epgGuide_today()}</span>
		</button>
	</div>

	<div class="space-y-2">
		<div class="flex items-center gap-2">
			<div class="relative w-full">
				<Search
					class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
				/>
				<input
					type="text"
					placeholder={m.livetv_epgGuide_searchPlaceholder()}
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-9 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					bind:value={channelSearch}
				/>
			</div>
			<label class="flex shrink-0 items-center gap-1.5" title={m.livetv_epg_displayLanguage()}>
				<span class="sr-only">{m.livetv_epg_displayLanguage()}</span>
				<select
					class="select-bordered select w-auto select-sm"
					value={displayLanguage}
					onchange={handleDisplayLanguageChange}
					aria-label={m.livetv_epg_displayLanguage()}
				>
					<option value="">{m.livetv_epg_displayLanguageAuto()}</option>
					{#each ALL_LANGUAGE_OPTIONS as option (option.code)}
						<option value={option.code}>{option.name}</option>
					{/each}
				</select>
			</label>
		</div>
		{#if channelSearch}
			<div class="text-xs text-base-content/60">
				{m.livetv_epgGuide_showingCount({ count: filteredLineup.length, total: lineup.length })}
			</div>
		{/if}
		{#if loadingPrograms && programsByChannel.size > 0}
			<div class="text-xs text-base-content/60">{m.livetv_epgGuide_updating()}</div>
		{/if}
	</div>

	<!-- Guide grid -->
	{#if loading || (loadingPrograms && programsByChannel.size === 0)}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary" />
		</div>
	{:else if lineup.length === 0}
		<div class="py-12 text-center text-base-content/50">{m.livetv_epgGuide_noChannels()}</div>
	{:else if filteredLineup.length === 0}
		<div class="py-12 text-center text-base-content/50">{m.livetv_epgGuide_noMatch()}</div>
	{:else}
		<div
			class="relative overflow-auto rounded-lg border border-base-300 bg-base-100"
			style="height: {viewportContainerHeight}px;"
			bind:this={gridViewportEl}
			onscroll={handleGridScroll}
		>
			<div class="relative" style="min-width: {CHANNEL_COLUMN_WIDTH + gridWidth}px;">
				<!-- Time header -->
				<div class="sticky top-0 z-30 flex border-b border-base-300 bg-base-200">
					<!-- Channel column header -->
					<div
						class="sticky top-0 left-0 z-40 flex shrink-0 items-center border-r border-base-300 bg-base-200 px-3 font-medium"
						style="width: {CHANNEL_COLUMN_WIDTH}px; height: 40px;"
					>
						{m.livetv_epgGuide_channelsHeader()}
					</div>
					<!-- Time slots -->
					<div class="relative flex" style="width: {gridWidth}px;">
						{#each timeSlots as slotTime (slotTime)}
							{@const slotDate = new Date(slotTime)}
							<div
								class="flex shrink-0 items-center justify-center border-r px-2 py-2 text-center text-xs font-medium {slotDate.getMinutes() ===
								0
									? 'border-base-300/70 bg-base-200/70 text-base-content/90'
									: 'border-base-300/40 bg-base-200/45 text-base-content/65'}"
								style="width: {SLOT_WIDTH}px;"
							>
								<span class="whitespace-nowrap">{formatTime(slotDate)}</span>
							</div>
						{/each}

						<!-- Header time indicator -->
						{#if nowTimelineOffset !== null}
							<div
								class="pointer-events-none absolute top-0 h-full"
								style="left: {nowTimelineOffset}px; z-index: 5;"
							>
								<div class="h-full w-0.5 bg-error"></div>
								<div
									class="absolute -top-1 -left-1 h-3 w-3 rounded-full border-2 border-error bg-base-100"
								></div>
							</div>
						{/if}
					</div>
				</div>

				<!-- Channel rows -->
				<div class="relative" style="height: {totalRowsHeight}px;">
					{#each visibleChannels as channel, visibleIndex (channel.id)}
						{@const programs = programsByChannel.get(channel.id) || []}
						{@const rowIndex = virtualStartIndex + visibleIndex}
						<div
							class="absolute right-0 left-0 flex border-b border-base-300/50"
							style="top: {rowIndex * ROW_TOTAL_HEIGHT}px; height: {ROW_HEIGHT}px;"
						>
							<!-- Channel info (sticky) -->
							<div
								class="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-base-300 bg-base-100 px-3"
								style="width: {CHANNEL_COLUMN_WIDTH}px; height: {ROW_HEIGHT}px;"
							>
								{#if channel.displayLogo}
									<img
										src={channel.displayLogo}
										alt=""
										class="h-8 w-8 shrink-0 rounded bg-base-300 object-contain"
									/>
								{:else}
									<div
										class="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-base-300"
									>
										<Tv class="h-4 w-4 text-base-content/30" />
									</div>
								{/if}
								<div class="min-w-0">
									<div class="min-w-[6ch] truncate text-sm font-medium" title={channel.displayName}>
										{channel.displayName}
									</div>
									{#if channel.channelNumber}
										<div class="text-xs text-base-content/50">#{channel.channelNumber}</div>
									{/if}
								</div>
								<div
									class="pointer-events-none absolute right-0 bottom-0 left-0 border-t border-base-300/80"
								></div>
							</div>

							<!-- Programs -->
							<div class="relative" style="width: {gridWidth}px; height: {ROW_HEIGHT}px;">
								<div class="pointer-events-none absolute inset-0 flex">
									{#each timeSlots as slotTime (slotTime)}
										{@const slotDate = new Date(slotTime)}
										<div
											class="relative h-full shrink-0 border-r {slotDate.getMinutes() === 0
												? 'border-base-300/50 bg-base-200/15'
												: 'border-base-300/30 bg-base-100/10'}"
											style="width: {SLOT_WIDTH}px;"
										>
											{#if programs.length === 0}
												<div
													class="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-base-content/35"
												>
													{m.livetv_epgGuide_na()}
												</div>
											{/if}
										</div>
									{/each}
								</div>

								{#each programs as program (program.id)}
									{@const isCurrent = isCurrentlyAiring(program)}
									<button
										class="absolute top-1 z-10 flex h-[calc(100%-8px)] cursor-pointer items-center overflow-hidden rounded border px-2 text-left text-sm transition-colors {isCurrent
											? 'border-primary/30 bg-primary/20 hover:bg-primary/30'
											: 'border-base-300 bg-base-200 hover:bg-base-300'}"
										style={getProgramStyle(program)}
										onclick={() => showProgramDetails(program, channel)}
										title="{program.title}{program.description ? `: ${program.description}` : ''}"
									>
										<span class="truncate">
											{#if isCurrent}
												<span class="mr-1 inline-block h-2 w-2 rounded-full bg-primary"></span>
											{/if}
											{program.title}
										</span>
									</button>
								{/each}
							</div>
						</div>
					{/each}

					<!-- Body time indicator -->
					{#if nowTimelineOffset !== null}
						<div
							class="pointer-events-none absolute top-0 h-full"
							style="left: {CHANNEL_COLUMN_WIDTH + nowTimelineOffset}px; z-index: 15;"
						>
							<div class="h-full w-0.5 bg-error"></div>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- Program details modal -->
{#if selectedProgram}
	<div class="modal modal-open">
		<div class="modal-box w-full max-w-[min(28rem,calc(100vw-2rem))] wrap-break-word">
			<div class="mb-4 flex items-start justify-between">
				<div>
					<h3 class="text-lg font-bold">{m.livetv_epgGuide_programTitle()}</h3>
					<p class="text-sm text-base-content/60">{selectedProgram.program.title}</p>
					<p class="text-sm text-base-content/60">
						{m.livetv_epgGuide_channel()}: {selectedProgram.channel.displayName}
					</p>
				</div>
				<button class="btn btn-circle btn-ghost btn-sm" onclick={closeProgramDetails}>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="space-y-3">
				<div class="flex items-center gap-2 text-sm">
					<Clock class="h-4 w-4 text-base-content/50" />
					<span>
						{formatTime(new Date(selectedProgram.program.startTime))} -
						{formatTime(new Date(selectedProgram.program.endTime))}
					</span>
					{#if isCurrentlyAiring(selectedProgram.program)}
						<span class="badge badge-sm badge-primary"
							>{m.livetv_channelScheduleModal_liveBadge()}</span
						>
					{/if}
				</div>

				{#if selectedProgram.program.category}
					<div class="badge badge-ghost badge-sm">{selectedProgram.program.category}</div>
				{/if}

				{#if selectedProgram.program.description}
					<p class="text-sm text-base-content/80">{selectedProgram.program.description}</p>
				{/if}

				{#if selectedProgram.program.director}
					<div class="text-sm">
						<span class="text-base-content/50">{m.livetv_epgGuide_director()}:</span>
						{selectedProgram.program.director}
					</div>
				{/if}

				{#if selectedProgram.program.actor}
					<div class="text-sm">
						<span class="text-base-content/50">{m.livetv_epgGuide_cast()}:</span>
						{selectedProgram.program.actor}
					</div>
				{/if}
			</div>

			<div class="modal-action">
				<button class="btn btn-ghost" onclick={closeProgramDetails}>{m.action_close()}</button>
			</div>
		</div>
		<button
			type="button"
			class="modal-backdrop cursor-default border-none bg-black/50"
			onclick={closeProgramDetails}
			aria-label={m.ui_modal_closeModal()}
		></button>
	</div>
{/if}
