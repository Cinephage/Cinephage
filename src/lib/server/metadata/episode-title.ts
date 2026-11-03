/**
 * Detection of TMDB-generated placeholder episode titles.
 *
 * When an episode has no translation for the requested language, TMDB does
 * not omit the field - it synthesizes one from the "Episode N" template in
 * that language (e.g. German "Folge 4", French "Épisode 3", Russian
 * "Эпизод 9"). Storing such a name destroys the real title. This matcher
 * recognizes the generated templates across languages so callers can fall
 * back to the original-language data instead.
 */
const GENERATED_TITLE_TEMPLATE =
	/^(?:episode|folge|épisode|episodio|episódio|episodul|odcinek|эпизод|епізод|епизод|bölüm|epizoda|epizód|epizód|jakso|avsnitt|aflevering|afl\.?|επεισόδιο)\s*\d{1,4}$/i;

const GENERATED_TITLE_CJK = /^第\s*\d{1,4}\s*[話集话]$|^제\s*\d{1,4}\s*화$/;

export function isGeneratedEpisodeTitle(name: string | null | undefined): boolean {
	const trimmed = name?.trim() ?? '';
	if (trimmed === '') return true;
	return GENERATED_TITLE_TEMPLATE.test(trimmed) || GENERATED_TITLE_CJK.test(trimmed);
}
