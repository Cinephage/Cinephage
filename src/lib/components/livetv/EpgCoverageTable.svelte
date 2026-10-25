<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { Tv, Check, AlertCircle, ArrowRight, Calendar, Loader2, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type {
		ChannelLineupItemWithDetails,
		EpgProgram,
		EpgProgramWithProgress
	} from '#lib/types/livetv.js';

	interface NowNextEntry {
		now: EpgProgramWithProgress | null;
		next: EpgProgram | null;
	}

	type EpgFilter = 'all' | 'missing' | 'override' | 'has-epg';

	interface Props {
		lineup: ChannelLineupItemWithDetails[];
		epgData: SvelteMap<string, NowNextEntry>;
		loading: boolean;
		onSetEpgSource: (channel: ChannelLineupItemWithDetails) => void;
	}

	let { lineup, epgData, loading, onSetEpgSource }: Props = $props();

	let filter = $state<EpgFilter>('all');
	let searchQuery = $state('');

	function getEpgStatus(
		channel: ChannelLineupItemWithDetails,
		epg: NowNextEntry | undefined
	): 'has-epg' | 'missing' | 'override' {
		if (channel.epgSourceChannelId) {
			return 'override';
		}
		if (epg?.now || epg?.next) {
			return 'has-epg';
		}
		return 'missing';
	}

	const filteredLineup = $derived.by(() => {
		let result = lineup;

		// Apply search filter
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			result = result.filter(
				(ch) =>
					ch.displayName.toLowerCase().includes(query) ||
					ch.accountName.toLowerCase().includes(query)
			);
		}

		// Apply EPG status filter
		if (filter !== 'all') {
			result = result.filter((ch) => {
				const epg = epgData.get(ch.channelId);
				const status = getEpgStatus(ch, epg);
				return status === filter;
			});
		}

		return result;
	});

	const stats = $derived.by(() => {
		let hasEpg = 0;
		let missing = 0;
		let override = 0;

		for (const ch of lineup) {
			const epg = epgData.get(ch.channelId);
			const status = getEpgStatus(ch, epg);
			if (status === 'has-epg') hasEpg++;
			else if (status === 'missing') missing++;
			else if (status === 'override') override++;
		}

		return { hasEpg, missing, override, total: lineup.length };
	});
</script>

<div class="space-y-4">
	<!-- Stats and filters -->
	<div class="space-y-3">
		<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
			<div class="rounded-xl bg-base-200 px-3 py-2">
				<div class="stat-title">{m.livetv_epgCoverage_total()}</div>
				<div class="stat-value text-xl sm:text-2xl">{stats.total}</div>
			</div>
			<div class="rounded-xl bg-base-200 px-3 py-2">
				<div class="stat-title">{m.livetv_epgCoverage_hasEpg()}</div>
				<div class="stat-value text-xl text-success sm:text-2xl">{stats.hasEpg}</div>
			</div>
			<div class="rounded-xl bg-base-200 px-3 py-2">
				<div class="stat-title">{m.livetv_epgCoverage_missing()}</div>
				<div class="stat-value text-xl text-error sm:text-2xl">{stats.missing}</div>
			</div>
			<div class="rounded-xl bg-base-200 px-3 py-2">
				<div class="stat-title">{m.livetv_epgCoverage_override()}</div>
				<div class="stat-value text-xl text-info sm:text-2xl">{stats.override}</div>
			</div>
		</div>

		<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
			<div class="relative w-full sm:w-56">
				<Search
					class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
				/>
				<input
					type="text"
					placeholder={m.livetv_epgCoverage_searchPlaceholder()}
					class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-9 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
					bind:value={searchQuery}
				/>
			</div>
			<select class="select-bordered select w-full select-sm sm:w-48" bind:value={filter}>
				<option value="all">{m.livetv_epgCoverage_filterAll()}</option>
				<option value="missing">{m.livetv_epgCoverage_filterMissing()}</option>
				<option value="has-epg">{m.livetv_epgCoverage_filterHasEpg()}</option>
				<option value="override">{m.livetv_epgCoverage_filterOverride()}</option>
			</select>
		</div>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary" />
		</div>
	{:else if filteredLineup.length === 0}
		<div class="py-12 text-center text-base-content/50">
			{#if lineup.length === 0}
				{m.livetv_epgCoverage_noChannels()}
			{:else}
				{m.livetv_epgCoverage_noMatch()}
			{/if}
		</div>
	{:else}
		<!-- Mobile cards -->
		<div class="space-y-2 sm:hidden">
			{#each filteredLineup as channel (channel.id)}
				{@const epg = epgData.get(channel.channelId)}
				{@const status = getEpgStatus(channel, epg)}
				<div class="rounded-xl border border-base-content/10 bg-base-100 p-3">
					<div class="flex items-start gap-3">
						{#if channel.displayLogo}
							<img
								src={channel.displayLogo}
								alt=""
								class="h-9 w-9 rounded bg-base-300 object-contain"
							/>
						{:else}
							<div class="flex h-9 w-9 items-center justify-center rounded bg-base-300">
								<Tv class="h-4 w-4 text-base-content/30" />
							</div>
						{/if}

						<div class="min-w-0 flex-1">
							<div class="truncate font-medium">{channel.displayName}</div>
							<div class="text-xs text-base-content/60">{channel.accountName}</div>
							{#if channel.channelNumber}
								<div class="mt-0.5 text-xs text-base-content/50">#{channel.channelNumber}</div>
							{/if}
						</div>

						{#if status === 'has-epg'}
							<div class="badge gap-1 badge-sm badge-success">
								<Check class="h-3 w-3" />
								{m.livetv_epgCoverage_hasEpgBadge()}
							</div>
						{:else if status === 'missing'}
							<div class="badge gap-1 badge-sm badge-error">
								<AlertCircle class="h-3 w-3" />
								{m.livetv_epgCoverage_missingBadge()}
							</div>
						{:else}
							<div class="badge gap-1 badge-sm badge-info">
								<ArrowRight class="h-3 w-3" />
								{m.livetv_epgCoverage_overrideBadge()}
							</div>
						{/if}
					</div>

					<div class="mt-3 rounded-lg bg-base-200 px-3 py-2">
						<div class="mb-1 text-[11px] tracking-wide text-base-content/50 uppercase">
							{m.livetv_epgCoverage_currentProgram()}
						</div>
						{#if epg?.now}
							<div class="truncate text-sm font-medium" title={epg.now.title}>{epg.now.title}</div>
							<div class="mt-1 flex items-center gap-2">
								<progress
									class="progress h-1.5 w-20 progress-primary"
									value={epg.now.progress * 100}
									max="100"
								></progress>
								<span class="text-xs text-base-content/50"
									>{m.livetv_channelLineupRow_minutesLeft({
										count: epg.now.remainingMinutes
									})}</span
								>
							</div>
						{:else}
							<div class="text-sm text-base-content/40">{m.livetv_epgCoverage_noData()}</div>
						{/if}
					</div>

					<div class="mt-3 flex items-center justify-between gap-2">
						<div class="min-w-0 text-sm">
							<div class="text-[11px] tracking-wide text-base-content/50 uppercase">
								{m.livetv_epgCoverage_epgSource()}
							</div>
							{#if channel.epgSourceChannel}
								<div class="flex items-center gap-1 text-info">
									<Calendar class="h-3 w-3" />
									<span class="truncate">{channel.epgSourceChannel.name}</span>
								</div>
							{:else}
								<span class="text-base-content/60">{m.livetv_epgCoverage_default()}</span>
							{/if}
						</div>

						<button
							class="btn btn-ghost btn-xs"
							onclick={() => onSetEpgSource(channel)}
							title={m.livetv_epgCoverage_setEpgSource()}
						>
							{m.livetv_epgCoverage_setEpg()}
						</button>
					</div>
				</div>
			{/each}
		</div>

		<!-- Desktop table -->
		<div class="hidden overflow-x-auto sm:block">
			<table class="table table-sm">
				<thead>
					<tr>
						<th class="w-12"></th>
						<th>{m.common_name()}</th>
						<th class="hidden lg:table-cell">{m.nav_accounts()}</th>
						<th>EPG {m.common_status()}</th>
						<th class="hidden md:table-cell">{m.livetv_epgCoverage_currentProgram()}</th>
						<th>{m.livetv_epgCoverage_epgSource()}</th>
						<th class="w-24">{m.common_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredLineup as channel (channel.id)}
						{@const epg = epgData.get(channel.channelId)}
						{@const status = getEpgStatus(channel, epg)}
						<tr class="hover">
							<td>
								{#if channel.displayLogo}
									<img
										src={channel.displayLogo}
										alt=""
										class="h-8 w-8 rounded bg-base-300 object-contain"
									/>
								{:else}
									<div class="flex h-8 w-8 items-center justify-center rounded bg-base-300">
										<Tv class="h-4 w-4 text-base-content/30" />
									</div>
								{/if}
							</td>
							<td>
								<div class="font-medium">{channel.displayName}</div>
								{#if channel.channelNumber}
									<div class="text-xs text-base-content/50">#{channel.channelNumber}</div>
								{/if}
							</td>
							<td class="hidden lg:table-cell">
								<span class="text-sm text-base-content/70">{channel.accountName}</span>
							</td>
							<td>
								{#if status === 'has-epg'}
									<div class="badge gap-1 badge-sm badge-success">
										<Check class="h-3 w-3" />
										{m.livetv_epgCoverage_hasEpgBadge()}
									</div>
								{:else if status === 'missing'}
									<div class="badge gap-1 badge-sm badge-error">
										<AlertCircle class="h-3 w-3" />
										{m.livetv_epgCoverage_missingBadge()}
									</div>
								{:else}
									<div class="badge gap-1 badge-sm badge-info">
										<ArrowRight class="h-3 w-3" />
										{m.livetv_epgCoverage_overrideBadge()}
									</div>
								{/if}
							</td>
							<td class="hidden md:table-cell">
								{#if epg?.now}
									<div class="max-w-48 truncate text-sm" title={epg.now.title}>
										{epg.now.title}
									</div>
									<div class="flex items-center gap-2">
										<progress
											class="progress h-1 w-16 progress-primary"
											value={epg.now.progress * 100}
											max="100"
										></progress>
										<span class="text-xs text-base-content/50"
											>{m.livetv_channelLineupRow_minutesLeft({
												count: epg.now.remainingMinutes
											})}</span
										>
									</div>
								{:else}
									<span class="text-sm text-base-content/40">{m.livetv_epgCoverage_noData()}</span>
								{/if}
							</td>
							<td
								class="cursor-pointer rounded transition-colors hover:bg-base-200"
								ondblclick={() => onSetEpgSource(channel)}
								role="button"
								tabindex="0"
								onkeydown={(e) => e.key === 'Enter' && onSetEpgSource(channel)}
								title={m.livetv_epgCoverage_doubleClickToChange()}
							>
								{#if channel.epgSourceChannel}
									<div class="flex items-center gap-1 text-sm text-info">
										<Calendar class="h-3 w-3" />
										<span class="max-w-24 truncate">{channel.epgSourceChannel.name}</span>
									</div>
								{:else}
									<span class="text-sm text-base-content/40">{m.livetv_epgCoverage_default()}</span>
								{/if}
							</td>
							<td>
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onSetEpgSource(channel)}
									title={m.livetv_epgCoverage_setEpgSource()}
								>
									{m.livetv_epgCoverage_setEpg()}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
