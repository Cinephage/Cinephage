/**
 * Language utilities for stream selection.
 *
 * The audio-preference policy core (four-bucket ranking, effective-preference
 * equality) lives in `#lib/server/languages/audio-preference.ts` so the
 * acquisition paths can consume the same ranking; this module re-exports it
 * for the existing streaming consumers and keeps the stream-shaped helpers.
 */

export {
	languageMatches,
	getLanguagePriority,
	DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
	audioPreferencesEqual,
	AUDIO_PREFERENCE_BUCKETS,
	resolveAudioPreferenceBucket,
	sortSourcesByAudioPreference
} from '#lib/server/languages/audio-preference.js';
export type { EffectiveAudioPreference } from '#lib/server/languages/audio-preference.js';
