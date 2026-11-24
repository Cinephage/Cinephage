/**
 * The root-folder page's view of the media-kind registry.
 *
 * The registry owns the vocabulary; this module owns the translated strings and
 * the icon/tone each kind renders with. Every map is a `Record<KindId, …>`, so
 * adding a kind to the registry fails the type check here until it is given a
 * label, an icon and a colour — the point of the registry is that no surface
 * keeps its own `'movie' | 'tv'` list.
 */
import { Disc3, Film, Tv } from '@lucide/svelte';
import * as m from '#lib/paraglide/messages.js';
import { LIBRARY_KIND_IDS, type KindId } from '#lib/media-kinds/registry.js';

/** Kinds that may own a root folder, in registry order. */
export const ROOT_FOLDER_KINDS = LIBRARY_KIND_IDS;

export const ROOT_FOLDER_KIND_LABEL: Record<KindId, () => string> = {
	movie: m.rootFolders_movies,
	tv: m.rootFolders_tvShows,
	music: m.rootFolders_music
};

export const ROOT_FOLDER_KIND_TITLE: Record<KindId, () => string> = {
	movie: m.rootFolders_movieFoldersTitle,
	tv: m.rootFolders_tvFoldersTitle,
	music: m.rootFolders_musicFoldersTitle
};

export const ROOT_FOLDER_KIND_ICON: Record<KindId, typeof Film> = {
	movie: Film,
	tv: Tv,
	music: Disc3
};

/** Literal classes so Tailwind keeps them in the build. */
export const ROOT_FOLDER_KIND_TONE: Record<KindId, string> = {
	movie: 'bg-primary/15 text-primary',
	tv: 'bg-secondary/15 text-secondary',
	music: 'bg-accent/15 text-accent'
};
