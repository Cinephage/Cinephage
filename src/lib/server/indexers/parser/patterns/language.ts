/**
 * Language Pattern Matching
 *
 * Extracts language information from release titles
 * Returns ISO 639-1 language codes, plus the pseudo-codes 'multi'
 * (multi-language release) and 'orig' (original-audio marker).
 *
 * Honesty contract: absence of evidence is NOT English. Untagged releases
 * yield `languages: []` and 'multi' is never expanded to 'en' - consumers
 * must handle empty lists and pseudo-codes explicitly.
 */

interface LanguageMatch {
	languages: string[];
	matchedTexts: string[];
}

/**
 * Language patterns mapping to ISO 639-1 codes
 */
const LANGUAGE_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
	// Multi-language indicators
	{ pattern: /\bmulti(?:[\s._-]?(?:lang|language|audio|sub)?)?\b/i, code: 'multi' },
	// "Dual" counts as multi only with language context ("Dual Audio", "DUAL ESP-ENG",
	// "dual-lat") - a bare "Dual" stays untagged so the movie title "Dual (2022)"
	// does not false-positive.
	{
		pattern: /\bdual(?=[\s._-]*(?:audio|lang|lat|latino|esp|spa|eng|castellano|subs?\b))/i,
		code: 'multi'
	},
	// Nordic packs carry multiple Scandinavian dubs alongside the original track.
	{ pattern: /\bnordi?c\b/i, code: 'multi' },

	// RuTracker-style "original audio" marker: releases named like
	// "3 XX + Original + RUS" carry the original (untranslated) audio track.
	// Sonarr added the same token in 2025 (Sonarr#7372). It is recorded as its
	// own pseudo-code rather than a specific language: the original audio of a
	// release can be any language, and forcing 'en' here would mislabel
	// e.g. French originals on Russian-tracker releases. Requires the +/-/|
	// separator context so movie titles like "Original Sin" are not matched.
	{ pattern: /(?:[+|]\s*original\b|\boriginal\s*[+|])/i, code: 'orig' },
	{ pattern: /(?:[+|]\s*оригинал\b|оригинал\b\s*[+|])/i, code: 'orig' },

	// English variants
	{ pattern: /\benglish\b/i, code: 'en' },
	{ pattern: /\beng\b/i, code: 'en' },

	// German variants
	{ pattern: /\bgerman\b/i, code: 'de' },
	{ pattern: /\bdeutsch\b/i, code: 'de' },
	{ pattern: /\bger\b/i, code: 'de' },

	// French variants
	{ pattern: /\bfrench\b/i, code: 'fr' },
	{ pattern: /\bfrancais\b/i, code: 'fr' },
	{ pattern: /\bfre\b/i, code: 'fr' },
	{ pattern: /\bvff\b/i, code: 'fr' }, // Version Francaise
	{ pattern: /\bvostfr\b/i, code: 'fr' }, // French subtitles

	// Spanish variants
	{ pattern: /\bspanish\b/i, code: 'es' },
	{ pattern: /\bespanol\b/i, code: 'es' },
	{ pattern: /\besp\b/i, code: 'es' },
	{ pattern: /\bspa\b/i, code: 'es' },
	{ pattern: /\bcastellano\b/i, code: 'es' },
	{ pattern: /\blatino\b/i, code: 'es' },

	// Italian variants
	{ pattern: /\bitalian\b/i, code: 'it' },
	{ pattern: /\bitaliano\b/i, code: 'it' },
	{ pattern: /\bita\b/i, code: 'it' },

	// Portuguese variants
	{ pattern: /\bportuguese\b/i, code: 'pt' },
	{ pattern: /\bportugues\b/i, code: 'pt' },
	{ pattern: /\bpor\b/i, code: 'pt' },
	{ pattern: /\bbrazilian\b/i, code: 'pt' },

	// Russian variants
	{ pattern: /\brussian\b/i, code: 'ru' },
	{ pattern: /\brus\b/i, code: 'ru' },

	// Japanese variants
	{ pattern: /\bjapanese\b/i, code: 'ja' },
	{ pattern: /\bjpn\b/i, code: 'ja' },
	{ pattern: /\bjap\b/i, code: 'ja' },

	// Korean variants
	{ pattern: /\bkorean\b/i, code: 'ko' },
	{ pattern: /\bkor\b/i, code: 'ko' },

	// Chinese variants
	{ pattern: /\bchinese\b/i, code: 'zh' },
	{ pattern: /\bmandarin\b/i, code: 'zh' },
	{ pattern: /\bcantonese\b/i, code: 'zh' },
	{ pattern: /\bchi\b/i, code: 'zh' },
	{ pattern: /\bchn\b/i, code: 'zh' },

	// Hindi variants
	{ pattern: /\bhindi\b/i, code: 'hi' },
	{ pattern: /\bhin\b/i, code: 'hi' },

	// Arabic variants
	{ pattern: /\barabic\b/i, code: 'ar' },
	{ pattern: /\bara\b/i, code: 'ar' },

	// Dutch variants
	{ pattern: /\bdutch\b/i, code: 'nl' },
	{ pattern: /\bnederlands\b/i, code: 'nl' },
	{ pattern: /\bnld\b/i, code: 'nl' },

	// Polish variants
	{ pattern: /\bpolish\b/i, code: 'pl' },
	{ pattern: /\bpolski\b/i, code: 'pl' },
	{ pattern: /\bpol\b/i, code: 'pl' },

	// Swedish variants
	{ pattern: /\bswedish\b/i, code: 'sv' },
	{ pattern: /\bsvenska\b/i, code: 'sv' },
	{ pattern: /\bswe\b/i, code: 'sv' },

	// Norwegian variants
	{ pattern: /\bnorwegian\b/i, code: 'no' },
	{ pattern: /\bnorsk\b/i, code: 'no' },
	{ pattern: /\bnor\b/i, code: 'no' },

	// Danish variants
	{ pattern: /\bdanish\b/i, code: 'da' },
	{ pattern: /\bdansk\b/i, code: 'da' },
	{ pattern: /\bdan\b/i, code: 'da' },

	// Finnish variants
	{ pattern: /\bfinnish\b/i, code: 'fi' },
	{ pattern: /\bsuomi\b/i, code: 'fi' },
	{ pattern: /\bfin\b/i, code: 'fi' },

	// Turkish variants
	{ pattern: /\bturkish\b/i, code: 'tr' },
	{ pattern: /\bturkce\b/i, code: 'tr' },
	{ pattern: /\btur\b/i, code: 'tr' },

	// Greek variants
	{ pattern: /\bgreek\b/i, code: 'el' },
	{ pattern: /\bgre\b/i, code: 'el' },

	// Czech variants
	{ pattern: /\bczech\b/i, code: 'cs' },
	{ pattern: /\bcze\b/i, code: 'cs' },

	// Hungarian variants
	{ pattern: /\bhungarian\b/i, code: 'hu' },
	{ pattern: /\bmagyar\b/i, code: 'hu' },
	{ pattern: /\bhun\b/i, code: 'hu' },

	// Thai variants
	{ pattern: /\bthai\b/i, code: 'th' },
	{ pattern: /\btha\b/i, code: 'th' },

	// Vietnamese variants
	{ pattern: /\bvietnamese\b/i, code: 'vi' },
	{ pattern: /\bvie\b/i, code: 'vi' },

	// Hebrew variants
	{ pattern: /\bhebrew\b/i, code: 'he' },
	{ pattern: /\bheb\b/i, code: 'he' },

	// Ukrainian variants
	{ pattern: /\bukrainian\b/i, code: 'uk' },
	{ pattern: /\bukr\b/i, code: 'uk' },

	// Romanian variants
	{ pattern: /\bromanian\b/i, code: 'ro' },
	{ pattern: /\bromana\b/i, code: 'ro' },
	{ pattern: /\brum\b/i, code: 'ro' },

	// Bulgarian variants
	{ pattern: /\bbulgarian\b/i, code: 'bg' },
	{ pattern: /\bbul\b/i, code: 'bg' },

	// Croatian variants
	{ pattern: /\bcroatian\b/i, code: 'hr' },
	{ pattern: /\bhrvatski\b/i, code: 'hr' },
	{ pattern: /\bhrv\b/i, code: 'hr' },

	// Serbian variants
	{ pattern: /\bserbian\b/i, code: 'sr' },
	{ pattern: /\bsrpski\b/i, code: 'sr' },
	{ pattern: /\bsrp\b/i, code: 'sr' },

	// Slovenian variants
	{ pattern: /\bslovenian\b/i, code: 'sl' },
	{ pattern: /\bslovenscina\b/i, code: 'sl' },
	{ pattern: /\bslv\b/i, code: 'sl' },

	// Slovak variants
	{ pattern: /\bslovak\b/i, code: 'sk' },
	{ pattern: /\bslk\b/i, code: 'sk' },

	// Catalan variants
	{ pattern: /\bcatalan\b/i, code: 'ca' },

	// Indonesian variants
	{ pattern: /\bindonesian\b/i, code: 'id' },
	{ pattern: /\bindo\b/i, code: 'id' },

	// Malay variants
	{ pattern: /\bmalay\b/i, code: 'ms' },
	{ pattern: /\bmelayu\b/i, code: 'ms' },
	{ pattern: /\bmsa\b/i, code: 'ms' },

	// Persian variants
	{ pattern: /\bpersian\b/i, code: 'fa' },
	{ pattern: /\bfarsi\b/i, code: 'fa' },
	{ pattern: /\bfas\b/i, code: 'fa' },

	// Bengali / Tamil / Telugu variants
	{ pattern: /\bbengali\b/i, code: 'bn' },
	{ pattern: /\btamil\b/i, code: 'ta' },
	{ pattern: /\btam\b/i, code: 'ta' },
	{ pattern: /\btelugu\b/i, code: 'te' },
	{ pattern: /\btel\b/i, code: 'te' },

	// Baltic / Balkan variants
	{ pattern: /\blatvian\b/i, code: 'lv' },
	{ pattern: /\blatviesu\b/i, code: 'lv' },
	{ pattern: /\blav\b/i, code: 'lv' },
	{ pattern: /\blithuanian\b/i, code: 'lt' },
	{ pattern: /\blietuviskai\b/i, code: 'lt' },
	{ pattern: /\bbosnian\b/i, code: 'bs' },
	{ pattern: /\bbos\b/i, code: 'bs' },
	{ pattern: /\bmacedonian\b/i, code: 'mk' },
	{ pattern: /\bmkd\b/i, code: 'mk' },

	// Icelandic variants ('is' itself is excluded on purpose: common word)
	{ pattern: /\bicelandic\b/i, code: 'is' },
	{ pattern: /\bisl\b/i, code: 'is' }
];

/**
 * Bare ISO 639-1 codes accepted in the fan-release naming slot directly after
 * a parenthesized year, e.g. "Name (2019) de - S01E05" or
 * "Name (2012) de en - S02E05".
 *
 * Deliberately conservative:
 *  - only this exact slot qualifies (codes elsewhere in the title are ignored),
 *    because post-normalization the parser cannot distinguish a bare "de" in
 *    "le chateau de ma mere" from a language tag;
 *  - codes that double as common words are excluded (it, no, he, la, hi, el…).
 */
const BARE_ISO639_1_CODES = new Set([
	'de',
	'en',
	'fr',
	'es',
	'pt',
	'ru',
	'pl',
	'sv',
	'fi',
	'tr',
	'cs',
	'hu',
	'da',
	'nl',
	'ja',
	'ko',
	'zh',
	'th',
	'vi',
	// Additions: unambiguous codes present in the curated registry whose
	// releases previously got no language evidence at all.
	'ar',
	'uk',
	'ro',
	'bg',
	'hr',
	'sr',
	'sk',
	'sl',
	'ca',
	'id',
	'ms',
	'fa',
	'bn',
	'ta',
	'te',
	'lv',
	'lt',
	'bs',
	'mk'
]);

/** Captures the optional two-letter tag list that follows a "(YYYY)" year. */
const FAN_TAG_SLOT =
	/\((?:19|20)\d{2}\)\s+([A-Za-z]{2}(?:\s+[A-Za-z]{2}){0,5})(?=\s*(?:[-–)\]]|$))/;

/**
 * Extract all languages from a release title
 *
 * @param title - The release title to parse
 * @returns Object with array of ISO 639-1 language codes and matched texts
 */
export function extractLanguages(title: string): LanguageMatch {
	const languages: string[] = [];
	const matchedTexts: string[] = [];
	const seen = new Set<string>();

	for (const { pattern, code } of LANGUAGE_PATTERNS) {
		const match = title.match(pattern);
		if (match && !seen.has(code)) {
			seen.add(code);
			languages.push(code);
			matchedTexts.push(match[0]);
		}
	}

	const tagSlot = title.match(FAN_TAG_SLOT);
	if (tagSlot?.[1]) {
		for (const token of tagSlot[1].toLowerCase().split(/\s+/)) {
			if (!BARE_ISO639_1_CODES.has(token) || seen.has(token)) continue;
			seen.add(token);
			languages.push(token);
			matchedTexts.push(token);
		}
	}

	// No English assertion: an untagged release stays empty ([]), and a
	// "multi"/"dual audio" release yields only the 'multi' marker - neither is
	// evidence of English audio. The marker/empty contract is handled explicitly
	// by consumers (language boost ignores 'multi'; naming renders `und`).
	return { languages, matchedTexts };
}

/**
 * Check if release has explicit language information
 */
export function hasExplicitLanguage(title: string): boolean {
	return LANGUAGE_PATTERNS.some(({ pattern }) => pattern.test(title));
}

/**
 * Extract language tokens from a torrent FILE name (tier-3 evidence - the
 * names inside a pack, not the release title). Strips the extension, then
 * applies the same token table. File names are stronger evidence than titles
 * for multi-audio packs but still not proof: a ".es.srt" sidecar names its
 * subtitle, not an audio track - only ffprobe at import is definitive.
 */
export function extractLanguagesFromFileName(fileName: string): LanguageMatch {
	const base = fileName.replace(/\.[a-z0-9]{1,4}$/i, '').replace(/[._]+/g, ' ');
	return extractLanguages(base);
}
