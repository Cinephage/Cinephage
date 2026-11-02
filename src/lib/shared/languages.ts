/**
 * Shared Language Registry
 *
 * Single source of truth for language identity shared by client and server.
 * Contains the curated language set, canonical BCP-47 tags, and aliases.
 *
 * Full ISO 639-2/3 resolution for arbitrary observed tags (ffprobe, media
 * servers, release names) lives in the server-only normalizer at
 * `#lib/server/languages/normalize.ts`.
 */

/** Canonical BCP-47 language tag: 'en', 'pt-BR', 'zh-Hans', 'und' */
export type LanguageTag = string;

/** TMDB response locale: 'en-US', 'fr-FR' */
export type MetadataLocale = string;

/** TMDB original-language / discover filter value: 'ja', 'en' */
export type TmdbLanguage = string;

/** Release filename markers that are not languages */
export type ReleaseMarker = 'multi' | 'original' | 'unknown';

export interface LanguageVariant {
	/** Canonical BCP-47 tag, e.g. 'pt-BR', 'zh-Hans' */
	code: string;
	/** English display name */
	name: string;
}

export interface LanguageDefinition {
	/** Canonical BCP-47 base tag, e.g. 'en', 'pt' */
	code: string;
	/** ISO 639-2 bibliographic code, e.g. 'ger' */
	alpha3B?: string;
	/** ISO 639-2 terminologic code, e.g. 'deu' */
	alpha3T?: string;
	/** English name */
	name: string;
	/** Native name */
	nativeName?: string;
	/** Canonical regional/script variants */
	variants?: readonly LanguageVariant[];
}

const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
	{ code: 'en', alpha3B: 'eng', alpha3T: 'eng', name: 'English', nativeName: 'English' },
	{
		code: 'es',
		alpha3B: 'spa',
		alpha3T: 'spa',
		name: 'Spanish',
		nativeName: 'Español',
		variants: [{ code: 'es-419', name: 'Spanish (Latin America)' }]
	},
	{
		code: 'fr',
		alpha3B: 'fre',
		alpha3T: 'fra',
		name: 'French',
		nativeName: 'Français',
		variants: [{ code: 'fr-CA', name: 'French (Canada)' }]
	},
	{ code: 'de', alpha3B: 'ger', alpha3T: 'deu', name: 'German', nativeName: 'Deutsch' },
	{ code: 'it', alpha3B: 'ita', alpha3T: 'ita', name: 'Italian', nativeName: 'Italiano' },
	{
		code: 'pt',
		alpha3B: 'por',
		alpha3T: 'por',
		name: 'Portuguese',
		nativeName: 'Português',
		variants: [{ code: 'pt-BR', name: 'Portuguese (Brazil)' }]
	},
	{ code: 'ru', alpha3B: 'rus', alpha3T: 'rus', name: 'Russian', nativeName: 'Русский' },
	{
		code: 'zh',
		alpha3B: 'chi',
		alpha3T: 'zho',
		name: 'Chinese',
		nativeName: '中文',
		variants: [
			{ code: 'zh-Hans', name: 'Chinese (Simplified)' },
			{ code: 'zh-Hant', name: 'Chinese (Traditional)' }
		]
	},
	{ code: 'ja', alpha3B: 'jpn', alpha3T: 'jpn', name: 'Japanese', nativeName: '日本語' },
	{ code: 'ko', alpha3B: 'kor', alpha3T: 'kor', name: 'Korean', nativeName: '한국어' },
	{ code: 'ar', alpha3B: 'ara', alpha3T: 'ara', name: 'Arabic', nativeName: 'العربية' },
	{ code: 'hi', alpha3B: 'hin', alpha3T: 'hin', name: 'Hindi', nativeName: 'हिन्दी' },
	{ code: 'nl', alpha3B: 'dut', alpha3T: 'nld', name: 'Dutch', nativeName: 'Nederlands' },
	{ code: 'pl', alpha3B: 'pol', alpha3T: 'pol', name: 'Polish', nativeName: 'Polski' },
	{ code: 'sv', alpha3B: 'swe', alpha3T: 'swe', name: 'Swedish', nativeName: 'Svenska' },
	{ code: 'no', alpha3B: 'nor', alpha3T: 'nor', name: 'Norwegian', nativeName: 'Norsk' },
	{ code: 'da', alpha3B: 'dan', alpha3T: 'dan', name: 'Danish', nativeName: 'Dansk' },
	{ code: 'fi', alpha3B: 'fin', alpha3T: 'fin', name: 'Finnish', nativeName: 'Suomi' },
	{ code: 'el', alpha3B: 'gre', alpha3T: 'ell', name: 'Greek', nativeName: 'Ελληνικά' },
	{ code: 'tr', alpha3B: 'tur', alpha3T: 'tur', name: 'Turkish', nativeName: 'Türkçe' },
	{ code: 'he', alpha3B: 'heb', alpha3T: 'heb', name: 'Hebrew', nativeName: 'עברית' },
	{ code: 'th', alpha3B: 'tha', alpha3T: 'tha', name: 'Thai', nativeName: 'ไทย' },
	{ code: 'vi', alpha3B: 'vie', alpha3T: 'vie', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
	{ code: 'cs', alpha3B: 'cze', alpha3T: 'ces', name: 'Czech', nativeName: 'Čeština' },
	{ code: 'hu', alpha3B: 'hun', alpha3T: 'hun', name: 'Hungarian', nativeName: 'Magyar' },
	{ code: 'ro', alpha3B: 'rum', alpha3T: 'ron', name: 'Romanian', nativeName: 'Română' },
	{ code: 'bg', alpha3B: 'bul', alpha3T: 'bul', name: 'Bulgarian', nativeName: 'Български' },
	{ code: 'uk', alpha3B: 'ukr', alpha3T: 'ukr', name: 'Ukrainian', nativeName: 'Українська' },
	{
		code: 'id',
		alpha3B: 'ind',
		alpha3T: 'ind',
		name: 'Indonesian',
		nativeName: 'Bahasa Indonesia'
	},
	{ code: 'ms', alpha3B: 'may', alpha3T: 'msa', name: 'Malay', nativeName: 'Bahasa Melayu' },
	{ code: 'hr', alpha3B: 'hrv', alpha3T: 'hrv', name: 'Croatian', nativeName: 'Hrvatski' },
	{ code: 'sr', alpha3B: 'srp', alpha3T: 'srp', name: 'Serbian', nativeName: 'Српски' },
	{ code: 'sk', alpha3B: 'slo', alpha3T: 'slk', name: 'Slovak', nativeName: 'Slovenčina' },
	{ code: 'sl', alpha3B: 'slv', alpha3T: 'slv', name: 'Slovenian', nativeName: 'Slovenščina' },
	{ code: 'et', alpha3B: 'est', alpha3T: 'est', name: 'Estonian', nativeName: 'Eesti' },
	{ code: 'lv', alpha3B: 'lav', alpha3T: 'lav', name: 'Latvian', nativeName: 'Latviešu' },
	{ code: 'lt', alpha3B: 'lit', alpha3T: 'lit', name: 'Lithuanian', nativeName: 'Lietuvių' },
	{ code: 'fa', alpha3B: 'per', alpha3T: 'fas', name: 'Persian', nativeName: 'فارسی' },
	{ code: 'bn', alpha3B: 'ben', alpha3T: 'ben', name: 'Bengali', nativeName: 'বাংলা' },
	{ code: 'ta', alpha3B: 'tam', alpha3T: 'tam', name: 'Tamil', nativeName: 'தமிழ்' },
	{ code: 'te', alpha3B: 'tel', alpha3T: 'tel', name: 'Telugu', nativeName: 'తెలుగు' },
	{ code: 'ml', alpha3B: 'mal', alpha3T: 'mal', name: 'Malayalam', nativeName: 'മലയാളം' },
	{ code: 'kn', alpha3B: 'kan', alpha3T: 'kan', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
	{ code: 'mr', alpha3B: 'mar', alpha3T: 'mar', name: 'Marathi', nativeName: 'मराठी' },
	{ code: 'gu', alpha3B: 'guj', alpha3T: 'guj', name: 'Gujarati', nativeName: 'ગુજરાતી' },
	{ code: 'pa', alpha3B: 'pan', alpha3T: 'pan', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
	{ code: 'ur', alpha3B: 'urd', alpha3T: 'urd', name: 'Urdu', nativeName: 'اردو' },
	{ code: 'ne', alpha3B: 'nep', alpha3T: 'nep', name: 'Nepali', nativeName: 'नेपाली' },
	{ code: 'si', alpha3B: 'sin', alpha3T: 'sin', name: 'Sinhala', nativeName: 'සිංහල' },
	{ code: 'my', alpha3B: 'bur', alpha3T: 'mya', name: 'Burmese', nativeName: 'မြန်မာဘာသာ' },
	{ code: 'km', alpha3B: 'khm', alpha3T: 'khm', name: 'Khmer', nativeName: 'ខ្មែរ' },
	{ code: 'lo', alpha3B: 'lao', alpha3T: 'lao', name: 'Lao', nativeName: 'ລາວ' },
	{ code: 'mn', alpha3B: 'mon', alpha3T: 'mon', name: 'Mongolian', nativeName: 'Монгол' },
	{ code: 'ka', alpha3B: 'geo', alpha3T: 'kat', name: 'Georgian', nativeName: 'ქართული' },
	{ code: 'az', alpha3B: 'aze', alpha3T: 'aze', name: 'Azerbaijani', nativeName: 'Azərbaycan' },
	{ code: 'kk', alpha3B: 'kaz', alpha3T: 'kaz', name: 'Kazakh', nativeName: 'Қазақша' },
	{ code: 'uz', alpha3B: 'uzb', alpha3T: 'uzb', name: 'Uzbek', nativeName: "O'zbek" },
	{ code: 'tl', alpha3B: 'tgl', alpha3T: 'tgl', name: 'Tagalog', nativeName: 'Tagalog' },
	{ code: 'sw', alpha3B: 'swa', alpha3T: 'swa', name: 'Swahili', nativeName: 'Kiswahili' },
	{ code: 'am', alpha3B: 'amh', alpha3T: 'amh', name: 'Amharic', nativeName: 'አማርኛ' },
	{ code: 'is', alpha3B: 'ice', alpha3T: 'isl', name: 'Icelandic', nativeName: 'Íslenska' },
	{ code: 'mk', alpha3B: 'mac', alpha3T: 'mkd', name: 'Macedonian', nativeName: 'Македонски' },
	{ code: 'bs', alpha3B: 'bos', alpha3T: 'bos', name: 'Bosnian', nativeName: 'Bosanski' },
	{ code: 'sq', alpha3B: 'alb', alpha3T: 'sqi', name: 'Albanian', nativeName: 'Shqip' },
	{ code: 'cy', alpha3B: 'wel', alpha3T: 'cym', name: 'Welsh', nativeName: 'Cymraeg' },
	{ code: 'ga', alpha3B: 'gle', alpha3T: 'gle', name: 'Irish', nativeName: 'Gaeilge' },
	{ code: 'mt', alpha3B: 'mlt', alpha3T: 'mlt', name: 'Maltese', nativeName: 'Malti' },
	{ code: 'eu', alpha3B: 'baq', alpha3T: 'eus', name: 'Basque', nativeName: 'Euskara' },
	{ code: 'ca', alpha3B: 'cat', alpha3T: 'cat', name: 'Catalan', nativeName: 'Català' },
	{ code: 'gl', alpha3B: 'glg', alpha3T: 'glg', name: 'Galician', nativeName: 'Galego' },
	{ code: 'af', alpha3B: 'afr', alpha3T: 'afr', name: 'Afrikaans', nativeName: 'Afrikaans' },
	{ code: 'hy', alpha3B: 'arm', alpha3T: 'hye', name: 'Armenian', nativeName: 'Հայերեն' },
	{ code: 'be', alpha3B: 'bel', alpha3T: 'bel', name: 'Belarusian', nativeName: 'Беларуская' },
	{ code: 'ku', alpha3B: 'kur', alpha3T: 'kur', name: 'Kurdish', nativeName: 'Kurdî' },
	{ code: 'eo', alpha3B: 'epo', alpha3T: 'epo', name: 'Esperanto', nativeName: 'Esperanto' }
];

/**
 * Provider and legacy aliases that are not covered by ISO codes.
 * Keys are lower-case; values are canonical tags.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	pb: 'pt-BR',
	pob: 'pt-BR',
	chs: 'zh-Hans',
	zhs: 'zh-Hans',
	'zh-cn': 'zh-Hans',
	'zh-sg': 'zh-Hans',
	cht: 'zh-Hant',
	zht: 'zh-Hant',
	'zh-tw': 'zh-Hant',
	'zh-hk': 'zh-Hant',
	'es-la': 'es-419',
	nob: 'no',
	nno: 'no',
	nb: 'no',
	nn: 'no'
};

const LANGUAGE_LOOKUP = new Map<string, string>();
const LANGUAGE_BY_TAG = new Map<string, LanguageDefinition>();

for (const lang of SUPPORTED_LANGUAGES) {
	LANGUAGE_BY_TAG.set(lang.code, lang);
	LANGUAGE_LOOKUP.set(lang.code.toLowerCase(), lang.code);
	if (lang.alpha3B) LANGUAGE_LOOKUP.set(lang.alpha3B.toLowerCase(), lang.code);
	if (lang.alpha3T) LANGUAGE_LOOKUP.set(lang.alpha3T.toLowerCase(), lang.code);
	// English names resolve too (torznab `language` attrs use names, e.g. "Spanish")
	LANGUAGE_LOOKUP.set(lang.name.toLowerCase(), lang.code);
	for (const variant of lang.variants ?? []) {
		LANGUAGE_BY_TAG.set(variant.code, {
			...lang,
			code: variant.code,
			name: variant.name,
			variants: undefined
		});
		LANGUAGE_LOOKUP.set(variant.code.toLowerCase(), variant.code);
		LANGUAGE_LOOKUP.set(variant.name.toLowerCase(), variant.code);
	}
}

for (const [alias, tag] of Object.entries(LANGUAGE_ALIASES)) {
	LANGUAGE_LOOKUP.set(alias, tag);
}

/** All language codes including variants, for dropdown/select options */
export const ALL_LANGUAGE_OPTIONS: readonly { code: string; name: string }[] =
	SUPPORTED_LANGUAGES.flatMap((lang) => [
		{ code: lang.code, name: lang.name },
		...(lang.variants ?? []).map((variant) => ({ code: variant.code, name: variant.name }))
	]);

/** Set of canonical tags recognized by the curated registry */
export const VALID_LANGUAGE_CODES: ReadonlySet<string> = new Set(LANGUAGE_BY_TAG.keys());

/** Map for quick language name lookup by canonical tag */
export const LANGUAGE_CODE_TO_NAME: ReadonlyMap<string, string> = new Map(
	[...LANGUAGE_BY_TAG].map(([tag, definition]) => [tag, definition.name])
);

/**
 * Canonicalize any language input to a curated canonical tag.
 *
 * Accepts ISO 639-1 (`en`), ISO 639-2/B (`ger`), ISO 639-2/T (`deu`),
 * registered variants (`pt-br`, `zh-cn`), and provider aliases (`pob`).
 * Returns an empty string when the language cannot be resolved.
 */
export function canonicalizeLanguageTag(input: string): string {
	if (!input) return '';
	const cleaned = input.trim().replace(/_/g, '-');
	if (!cleaned) return '';
	const lower = cleaned.toLowerCase();
	const exact = LANGUAGE_LOOKUP.get(lower) ?? LANGUAGE_LOOKUP.get(lower.replace(/-/g, ''));
	if (exact) return exact;

	let canonical: string | undefined;
	try {
		canonical = Intl.getCanonicalLocales(cleaned)[0];
	} catch {
		return '';
	}
	if (!canonical) return '';
	const base = canonical.split('-')[0].toLowerCase();
	return LANGUAGE_LOOKUP.has(base) ? canonical : '';
}

/**
 * Look up a curated language definition by any recognized input.
 */
export function getLanguageDefinition(input: string): LanguageDefinition | undefined {
	const canonical = canonicalizeLanguageTag(input);
	return canonical ? LANGUAGE_BY_TAG.get(canonical) : undefined;
}

/** Validate whether an input resolves to a curated language tag */
export function isValidLanguageCode(code: string): boolean {
	return canonicalizeLanguageTag(code) !== '';
}

/**
 * Backward-compatible normalizer. Returns the canonical tag when resolvable,
 * otherwise the trimmed lower-case input so callers can still display it.
 */
export function normalizeLanguageCode(code: string): string {
	return canonicalizeLanguageTag(code) || code.trim().toLowerCase();
}

/** Get a display name for any language input. Falls back to the input itself. */
export function getLanguageName(code: string): string {
	const canonical = canonicalizeLanguageTag(code);
	if (!canonical) return code.toUpperCase();
	const direct = LANGUAGE_CODE_TO_NAME.get(canonical);
	if (direct) return direct;
	const [base, ...rest] = canonical.split('-');
	const baseName = LANGUAGE_CODE_TO_NAME.get(base);
	if (!baseName) return canonical;
	const region = rest.find((part) => part.length === 2);
	return region ? `${baseName} (${region.toUpperCase()})` : baseName;
}
