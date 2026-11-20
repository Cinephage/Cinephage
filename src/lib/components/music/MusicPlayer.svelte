<script lang="ts">
	import { Pause, Play, SkipBack, SkipForward, Volume2, X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { musicPlayer } from './player.svelte.js';

	// Side-effect only: the store creates its <audio> once the bar exists.
	$effect(() => {
		musicPlayer.attach();
	});

	function clock(seconds: number): string {
		if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	function inputValue(event: Event): string {
		return (event.currentTarget as HTMLInputElement).value;
	}
</script>

{#if musicPlayer.current}
	<div
		class="fixed inset-x-0 bottom-0 z-40 border-t border-base-content/10 bg-base-100/95 backdrop-blur"
	>
		<div class="mx-auto flex max-w-7xl items-center gap-3 px-3 py-2.5 sm:px-4">
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{musicPlayer.current.title}</p>
				<p class="truncate text-xs text-base-content/50">
					{musicPlayer.current.artist}
					{#if musicPlayer.failed}
						<span class="text-error"> · {m.music_playerUnavailable()}</span>
					{/if}
				</p>
			</div>

			<div class="flex shrink-0 items-center gap-1">
				<button
					type="button"
					class="btn btn-ghost btn-sm btn-square"
					title={m.action_previous()}
					aria-label={m.action_previous()}
					onclick={() => musicPlayer.previous()}
				>
					<SkipBack class="h-4 w-4" />
				</button>
				<button
					type="button"
					class="btn btn-primary btn-sm btn-circle"
					title={musicPlayer.playing ? m.action_pause() : m.action_play()}
					aria-label={musicPlayer.playing ? m.action_pause() : m.action_play()}
					onclick={() => musicPlayer.toggle()}
				>
					{#if musicPlayer.playing}
						<Pause class="h-4 w-4" />
					{:else}
						<Play class="h-4 w-4" />
					{/if}
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-sm btn-square"
					title={m.action_next()}
					aria-label={m.action_next()}
					onclick={() => musicPlayer.next()}
				>
					<SkipForward class="h-4 w-4" />
				</button>
			</div>

			<div class="hidden flex-[2] items-center gap-2 sm:flex">
				<span class="w-9 text-right text-[11px] tabular-nums text-base-content/50"
					>{clock(musicPlayer.currentTime)}</span
				>
				<input
					type="range"
					class="range range-xs flex-1"
					min="0"
					max={Math.max(musicPlayer.duration, 0)}
					step="1"
					value={musicPlayer.currentTime}
					oninput={(event) => musicPlayer.seek(Number(inputValue(event)))}
				/>
				<span class="w-9 text-[11px] tabular-nums text-base-content/50"
					>{clock(musicPlayer.duration)}</span
				>
			</div>

			<div class="hidden items-center gap-1.5 md:flex">
				<Volume2 class="h-4 w-4 shrink-0 text-base-content/50" />
				<input
					type="range"
					class="range range-xs w-20"
					min="0"
					max="1"
					step="0.05"
					value={musicPlayer.volume}
					oninput={(event) => musicPlayer.setVolume(Number(inputValue(event)))}
				/>
			</div>

			<button
				type="button"
				class="btn btn-ghost btn-sm btn-square shrink-0"
				title={m.action_close()}
				aria-label={m.action_close()}
				onclick={() => musicPlayer.close()}
			>
				<X class="h-4 w-4" />
			</button>
		</div>
	</div>
{/if}
