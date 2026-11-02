<script lang="ts">
	import { X, Loader2, Tv, Clock, Calendar } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { ChannelLineupItemWithDetails, EpgProgram } from '#lib/types/livetv.js';
	import { getEpgChannel, getStoredEpgDisplayLanguage } from '#lib/api/livetv.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { getLocale } from '#lib/paraglide/runtime.js';

	interface Props {
		open: boolean;
		channel: ChannelLineupItemWithDetails | null;
		onClose: () => void;
	}

	let { open, channel, onClose }: Props = $props();

	// Data state
	let programs = $state<EpgProgram[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Track modal open state for transition detection
	let wasOpen = $state(false);

	// Reset state and load data when modal opens
	$effect(() => {
		const justOpened = open && !wasOpen;
		wasOpen = open;

		if (justOpened && channel) {
			error = null;
			loadSchedule();
		}
	});

	async function loadSchedule() {
		if (!channel) return;

		loading = true;
		error = null;

		try {
			// Use EPG source channel if set, otherwise use primary channel
			const channelId = channel.epgSourceChannelId ?? channel.channelId;

			// Request 24 hours of data, with the persisted EPG display language
			// (empty = server falls back to the instance metadata locale).
			const now = new Date();
			const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
			const displayLanguage = getStoredEpgDisplayLanguage();

			const data = await getEpgChannel(channelId, {
				start: now.toISOString(),
				end: end.toISOString(),
				...(displayLanguage ? { lang: displayLanguage } : {})
			});
			programs = data.programs || [];
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_channelScheduleModal_failedToLoad();
			programs = [];
		} finally {
			loading = false;
		}
	}

	function formatTime(isoString: string): string {
		return new Intl.DateTimeFormat(getLocale(), {
			hour: 'numeric',
			minute: '2-digit'
		}).format(new Date(isoString));
	}

	function isCurrentlyAiring(program: EpgProgram): boolean {
		const now = Date.now();
		const start = new Date(program.startTime).getTime();
		const end = new Date(program.endTime).getTime();
		return now >= start && now < end;
	}

	function getProgress(program: EpgProgram): number {
		const now = Date.now();
		const start = new Date(program.startTime).getTime();
		const end = new Date(program.endTime).getTime();
		if (now < start) return 0;
		if (now >= end) return 100;
		return ((now - start) / (end - start)) * 100;
	}
</script>

<ModalWrapper
	open={open && !!channel}
	{onClose}
	maxWidth="2xl"
	labelledBy="channel-schedule-modal-title"
>
	{#if channel}
		<!-- Header -->
		<div class="mb-4 flex items-center justify-between">
			<div class="flex items-center gap-3">
				{#if channel.displayLogo}
					<img
						src={channel.displayLogo}
						alt=""
						class="h-10 w-10 rounded bg-base-300 object-contain"
					/>
				{:else}
					<div class="flex h-10 w-10 items-center justify-center rounded bg-base-300">
						<Tv class="h-5 w-5 text-base-content/30" />
					</div>
				{/if}
				<div>
					<h3 class="text-lg font-bold">{channel.displayName}</h3>
					<p class="text-sm text-base-content/60">{channel.accountName}</p>
				</div>
			</div>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
				<X class="h-4 w-4" />
			</button>
		</div>

		{#if channel.epgSourceChannelId && channel.epgSourceChannel}
			<div class="mb-4 flex items-center gap-2 rounded-lg bg-info/10 px-3 py-2 text-sm text-info">
				<Calendar class="h-4 w-4" />
				<span
					>{m.livetv_channelScheduleModal_epgFrom({ source: channel.epgSourceChannel.name })}</span
				>
			</div>
		{/if}

		<!-- Error -->
		{#if error}
			<div class="mb-4 alert alert-error">
				<span>{error}</span>
			</div>
		{/if}

		<!-- Program list -->
		<div class="max-h-96 overflow-y-auto">
			{#if loading}
				<div class="flex justify-center py-8">
					<Loader2 class="h-6 w-6 animate-spin text-base-content/50" />
				</div>
			{:else if programs.length === 0}
				<div class="py-8 text-center text-base-content/50">
					{m.livetv_channelScheduleModal_noPrograms()}
				</div>
			{:else}
				<div class="space-y-1">
					{#each programs as program (program.id)}
						{@const isCurrent = isCurrentlyAiring(program)}
						{@const progress = isCurrent ? getProgress(program) : 0}
						<div
							class="rounded-lg p-3 transition-colors {isCurrent
								? 'border border-primary/20 bg-primary/10'
								: 'hover:bg-base-200'}"
						>
							<div class="flex items-start gap-3">
								<div class="flex min-w-[100px] flex-col text-sm">
									<span class="flex items-center gap-1 font-mono text-base-content/70">
										<Clock class="h-3 w-3" />
										{formatTime(program.startTime)}
									</span>
									<span class="text-xs text-base-content/50">
										{formatTime(program.endTime)}
									</span>
								</div>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="font-medium">{program.title}</span>
										{#if isCurrent}
											<span class="badge badge-sm badge-primary"
												>{m.livetv_channelScheduleModal_liveBadge()}</span
											>
										{/if}
										{#if program.category}
											<span class="badge badge-ghost badge-sm">{program.category}</span>
										{/if}
									</div>
									{#if program.description}
										<p class="mt-1 line-clamp-2 text-sm text-base-content/60">
											{program.description}
										</p>
									{/if}
									{#if isCurrent}
										<div class="mt-2 flex items-center gap-2">
											<progress
												class="progress h-1.5 w-32 progress-primary"
												value={progress}
												max="100"
											></progress>
											<span class="text-xs text-base-content/50">
												{m.livetv_channelScheduleModal_percentRemaining({
													percent: Math.round(100 - progress)
												})}
											</span>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="modal-action">
			<button class="btn btn-ghost" onclick={onClose}>{m.action_close()}</button>
		</div>
	{/if}
</ModalWrapper>
