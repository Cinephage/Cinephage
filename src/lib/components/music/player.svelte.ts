/**
 * The one music player.
 *
 * A single <audio> element lives here so playback survives navigation: the bar
 * is mounted in the root layout and the album page only hands it a queue. The
 * stream URL is stable (`/api/streaming/music/track/{id}/stream`); the server
 * decides whether that is a local file or a provider stream.
 */
import { browser } from '$app/env';

export interface PlayerTrack {
	id: string;
	title: string;
	artist: string;
	duration?: number | null;
}

const streamUrl = (trackId: string) => `/api/streaming/music/track/${trackId}/stream`;

class MusicPlayerStore {
	queue = $state<PlayerTrack[]>([]);
	index = $state(-1);
	playing = $state(false);
	currentTime = $state(0);
	duration = $state(0);
	volume = $state(1);
	/** Set when the browser could not load or play the current source. */
	failed = $state(false);

	#audio: HTMLAudioElement | null = null;

	get current(): PlayerTrack | null {
		return this.queue[this.index] ?? null;
	}

	attach(): void {
		if (!browser || this.#audio) return;

		const audio = new Audio();
		audio.preload = 'metadata';

		audio.addEventListener('timeupdate', () => {
			this.currentTime = audio.currentTime;
		});
		audio.addEventListener('loadedmetadata', () => {
			this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
		});
		audio.addEventListener('play', () => {
			this.playing = true;
		});
		audio.addEventListener('pause', () => {
			this.playing = false;
		});
		audio.addEventListener('ended', () => {
			this.next();
		});
		audio.addEventListener('error', () => {
			this.failed = true;
			this.playing = false;
		});

		this.#audio = audio;
	}

	play(queue: PlayerTrack[], index: number): void {
		const track = queue[index];
		if (!track) return;

		this.attach();
		const audio = this.#audio;
		if (!audio) return;

		this.queue = queue;
		this.index = index;
		this.currentTime = 0;
		this.duration = 0;
		this.failed = false;
		audio.src = streamUrl(track.id);
		audio.volume = this.volume;
		void audio.play().catch(() => {
			this.failed = true;
			this.playing = false;
		});
	}

	toggle(): void {
		const audio = this.#audio;
		if (!audio) return;
		if (audio.paused) {
			void audio.play().catch(() => {
				this.failed = true;
			});
		} else {
			audio.pause();
		}
	}

	next(): void {
		if (this.index + 1 < this.queue.length) {
			this.play(this.queue, this.index + 1);
		}
	}

	previous(): void {
		// The familiar rule: a few seconds in, "previous" restarts the track.
		const audio = this.#audio;
		if (audio && audio.currentTime > 3) {
			this.seek(0);
			return;
		}
		if (this.index > 0) this.play(this.queue, this.index - 1);
	}

	seek(seconds: number): void {
		const audio = this.#audio;
		if (!audio || !Number.isFinite(seconds)) return;
		audio.currentTime = seconds;
		this.currentTime = seconds;
	}

	setVolume(value: number): void {
		this.volume = Math.min(1, Math.max(0, value));
		if (this.#audio) this.#audio.volume = this.volume;
	}

	close(): void {
		const audio = this.#audio;
		if (audio) {
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
		}
		this.queue = [];
		this.index = -1;
		this.playing = false;
		this.currentTime = 0;
		this.duration = 0;
		this.failed = false;
	}
}

export const musicPlayer = new MusicPlayerStore();
