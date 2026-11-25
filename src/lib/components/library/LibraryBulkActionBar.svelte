<script lang="ts">
	import { X, Eye, EyeOff, Sliders, Trash2, Loader2, Languages, Download } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		selectedCount: number;
		loading: boolean;
		currentAction: 'monitor' | 'unmonitor' | 'quality' | 'delete' | 'language' | 'grab' | null;
		/** Count-aware noun for the sentence, e.g. "movies" or "albums". */
		itemLabel: string;
		onMonitor: () => void;
		onUnmonitor: () => void;
		/** Bulk quality-profile assignment; both video and music lists wire it. */
		onChangeQuality?: () => void;
		/**
		 * Bulk acquisition: grab the best release for each selected album. Only the
		 * music list wires it — a movie or episode row is grabbed one at a time.
		 */
		onGrab?: () => void;
		/** Optional bulk language profile action. */
		onLanguage?: () => void;
		onDelete: () => void;
		onClear: () => void;
	}

	let {
		selectedCount,
		loading,
		currentAction,
		itemLabel,
		onMonitor,
		onUnmonitor,
		onChangeQuality,
		onGrab,
		onLanguage,
		onDelete,
		onClear
	}: Props = $props();
</script>

{#if selectedCount > 0}
	<div
		class="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-50 mx-auto max-w-fit"
	>
		<div
			class="flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-base-content/10 bg-base-300 px-2.5 py-2 shadow-xl sm:flex-nowrap sm:gap-3 sm:rounded-full sm:px-4 sm:py-2.5"
		>
			<span class="shrink-0 text-sm font-medium whitespace-nowrap">
				{selectedCount}
				<span class="hidden sm:inline">{itemLabel}</span> selected
			</span>

			<div class="h-4 w-px bg-base-content/20"></div>

			<div class="flex items-center gap-0.5 sm:gap-1">
				{#if onGrab}
					<button
						class="btn gap-1.5 btn-ghost px-2 btn-sm sm:px-3"
						onclick={onGrab}
						disabled={loading}
						title={m.music_grabBest()}
					>
						{#if loading && currentAction === 'grab'}
							<Loader2 size={16} class="animate-spin" />
						{:else}
							<Download size={16} />
						{/if}
						<span class="hidden sm:inline">{m.music_grabBest()}</span>
					</button>
				{/if}
				<button
					class="btn gap-1.5 btn-ghost px-2 btn-sm sm:px-3"
					onclick={onMonitor}
					disabled={loading}
					title={m.library_bulkActionBar_titleMonitor()}
				>
					{#if loading && currentAction === 'monitor'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<Eye size={16} />
					{/if}
					<span class="hidden sm:inline">{m.action_monitor()}</span>
				</button>

				<button
					class="btn gap-1.5 btn-ghost px-2 btn-sm sm:px-3"
					onclick={onUnmonitor}
					disabled={loading}
					title={m.library_bulkActionBar_titleUnmonitor()}
				>
					{#if loading && currentAction === 'unmonitor'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<EyeOff size={16} />
					{/if}
					<span class="hidden sm:inline">{m.action_unmonitor()}</span>
				</button>

				{#if onChangeQuality}
					<button
						class="btn gap-1.5 btn-ghost px-2 btn-sm sm:px-3"
						onclick={onChangeQuality}
						disabled={loading}
						title={m.library_bulkActionBar_titleQuality()}
					>
						{#if loading && currentAction === 'quality'}
							<Loader2 size={16} class="animate-spin" />
						{:else}
							<Sliders size={16} />
						{/if}
						<span class="hidden sm:inline">{m.common_quality()}</span>
					</button>
				{/if}

				{#if onLanguage}
					<button
						class="btn gap-1.5 btn-ghost px-2 btn-sm sm:px-3"
						onclick={onLanguage}
						disabled={loading}
						title="{m.library_subtitleProfile_label()} (bulk)"
					>
						{#if loading && currentAction === 'language'}
							<Loader2 size={16} class="animate-spin" />
						{:else}
							<Languages size={16} />
						{/if}
						<span class="hidden sm:inline">{m.library_subtitleProfile_label()}</span>
					</button>
				{/if}

				<button
					class="btn gap-1.5 btn-ghost px-2 text-error btn-sm hover:bg-error/10 sm:px-3"
					onclick={onDelete}
					disabled={loading}
					title={m.library_bulkActionBar_titleDelete()}
				>
					{#if loading && currentAction === 'delete'}
						<Loader2 size={16} class="animate-spin" />
					{:else}
						<Trash2 size={16} />
					{/if}
					<span class="hidden sm:inline">{m.common_delete()}</span>
				</button>
			</div>

			<div class="h-4 w-px bg-base-content/20"></div>

			<button
				class="btn btn-circle btn-ghost btn-sm"
				onclick={onClear}
				disabled={loading}
				title={m.library_bulkActionBar_titleClear()}
			>
				<X size={16} />
			</button>
		</div>
	</div>
{/if}
