import type { LiveTvProviderType } from '#lib/types/livetv.js';

const REGION_PREFIXES = new Set([
	'US',
	'UK',
	'CA',
	'AU',
	'NZ',
	'EN',
	'IN',
	'IR',
	'AR',
	'HR',
	'PK',
	'MU',
	'NA',
	'NP',
	'RU',
	'TR',
	'DE',
	'NL',
	'FR',
	'PL',
	'AL',
	'RO',
	'BG',
	'IT',
	'RS',
	'BE',
	'PT',
	'ES',
	'SW',
	'UAE',
	'HU',
	'DK',
	'BR',
	'NO',
	'GR',
	'BH',
	'EG',
	'IL',
	'CZ',
	'KU',
	'ARM',
	'MX',
	'LB',
	'MA',
	'MK',
	'FI',
	'SA',
	'AF',
	'DZ',
	'IQ',
	'CO',
	'CH',
	'AFG',
	'AZ',
	'JO',
	'TN',
	'SL',
	'BA',
	'SY',
	'GB',
	'KW',
	'ME',
	'PS',
	'SO',
	'SUR',
	'KS',
	'LY',
	'OM',
	'SD',
	'CY',
	'EXYU',
	'LT',
	'MT',
	'SR',
	'VS',
	'YE'
]);

const STRIP_PIPE_PREFIXES = new Set([
	'US',
	'UK',
	'CA',
	'AU',
	'NZ',
	'EN',
	'GO',
	'PK',
	'MU',
	'IN',
	'IR',
	'AR',
	'NA',
	'YP',
	'CITY',
	'SLING',
	'PRIME',
	'TUBI',
	'UK-NOWTV',
	'IN-PREM',
	'IN-NEWS',
	'ENGLISH',
	'HINDI',
	'TAMIL',
	'PUNJABI',
	'TELUGU',
	'MALAYALAM',
	'KANNADA',
	'GUJARATI',
	'BENGALI',
	'BHOJPURI',
	'RELIGIOUS',
	'AHL-TEAM',
	'NHL TEAM',
	'NFL TEAMS',
	'NBA TEAM',
	'IN-BG',
	'PAK-PREM',
	'PB-PREM',
	'TM-PREM',
	'KN-PREM',
	'D+',
	'BAN',
	'SRI'
]);

const KEEP_PIPE_PREFIXES = new Set([
	'NHL',
	'NFL',
	'NBA',
	'UFC',
	'UEFA',
	'F1',
	'EPL',
	'SPFL',
	'PPV'
]);

const TRAILING_TECHNICAL_PATTERNS = [
	/\s+ᴿᴬᵂ$/u,
	/\s+ᴴᴰ$/u,
	/\s+HEVC$/i,
	/\s+RAW$/i,
	/\s+SD$/i,
	/\s+HD\+?$/i,
	/\s+FHD$/i,
	/\s+UHD$/i,
	/\s+4K\+?$/i,
	/\s+8K$/i,
	/\s+8K EXCLUSIVE$/i,
	/\s+60FPS$/i,
	/\s+60 FPS$/i,
	/\s+myTeamTV$/i,
	/\s+\(UHD\/4K\)$/i,
	/\s+\(4K\/UHD\)$/i
];

const UPPERCASE_TOKEN = /^[A-Z][A-Z0-9&'+.-]*$/;
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'the', 'to']);
const ALWAYS_UPPERCASE_WORDS = new Set([
	'ABC',
	'A&E',
	'AMC',
	'BBC',
	'BET',
	'BTN+',
	'CBS',
	'CW',
	'ESPN',
	'FOX',
	'FX',
	'HBO',
	'HLN',
	'ION',
	'LA',
	'MAX',
	'MGM',
	'MLB',
	'MTV',
	'NBA',
	'NBC',
	'NFL',
	'NHL',
	'PBS',
	'PPV',
	'QVC',
	'TCM',
	'TBS',
	'TLC',
	'TMC',
	'TNT',
	'TSN',
	'TV',
	'UFC',
	'USA',
	'VICE',
	'WI',
	'WWE'
]);
const TITLE_CASE_OVERRIDES = new Map([
	['NEWSNATION', 'NewsNation'],
	['BABYSHARK', 'BabyShark'],
	['ONEPLAY', 'OnePlay'],
	['SPORTSNET', 'Sportsnet'],
	['BEIN', 'beIN'],
	['TRUTV', 'truTV'],
	['NAT', 'Nat'],
	['GEO', 'Geo']
]);
const SHORT_LOCATION_WORDS = new Set(['LA', 'NY', 'NJ', 'NC', 'SC', 'WA', 'DC', 'WI']);

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function titleCaseWord(word: string): string {
	if (!word) {
		return word;
	}

	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function shouldStripPipePrefix(prefix: string): boolean {
	const normalizedPrefix = collapseWhitespace(prefix).replace(/:+$/, '');
	const upperPrefix = normalizedPrefix.toUpperCase();

	if (!upperPrefix || KEEP_PIPE_PREFIXES.has(upperPrefix)) {
		return false;
	}

	if (STRIP_PIPE_PREFIXES.has(upperPrefix)) {
		return true;
	}

	if (REGION_PREFIXES.has(upperPrefix)) {
		return true;
	}

	if (/^[A-Z]{2,4}(?:-[A-Z0-9+]+)+$/.test(upperPrefix)) {
		return true;
	}

	return /(TEAMS?$|PREM$|NOWTV$|NEWS$)/.test(upperPrefix);
}

function smartCaseSegment(segment: string): string {
	const words = segment.split(' ');
	const uppercaseWords = words.filter((word) => /[A-Z]/.test(word) && UPPERCASE_TOKEN.test(word));
	const hasMultipleUppercaseWords = uppercaseWords.length >= 2;
	const looksLikeLocalAffiliate =
		/\b[A-Z]{2,}\s+\d+\b/.test(segment) && /\([A-Z0-9-]+\)$/.test(segment);

	if (!hasMultipleUppercaseWords) {
		const trimmedSegment = segment.trim();
		if (trimmedSegment && TITLE_CASE_OVERRIDES.has(trimmedSegment)) {
			return segment.replace(
				trimmedSegment,
				TITLE_CASE_OVERRIDES.get(trimmedSegment) || trimmedSegment
			);
		}

		return segment;
	}

	return words
		.map((word, index) => {
			if (!UPPERCASE_TOKEN.test(word)) {
				return word;
			}

			if (looksLikeLocalAffiliate && /^[A-Z]{2,}$/.test(word) && !SHORT_LOCATION_WORDS.has(word)) {
				return word;
			}

			if (ALWAYS_UPPERCASE_WORDS.has(word) || /^\d+$/.test(word) || /^\+\d+$/.test(word)) {
				return word;
			}

			const lower = word.toLowerCase();
			if (index > 0 && SMALL_WORDS.has(lower)) {
				return lower;
			}

			const override = TITLE_CASE_OVERRIDES.get(word);
			if (override) {
				return override;
			}

			return titleCaseWord(word);
		})
		.join(' ');
}

function applySmartCasing(value: string): string {
	return value
		.split(/(\s[-/:()]\s|\s-\s|\s\|\s)/)
		.map((segment) => {
			if (/^\s[-/:|()]\s$/.test(segment) || segment === ' - ') {
				return segment;
			}

			return smartCaseSegment(segment);
		})
		.join('');
}

function removeTrailingBracketMetadata(value: string): string {
	let normalized = value;
	while (/\s*\[[^\]]+\]\s*$/.test(normalized)) {
		normalized = normalized.replace(/\s*\[[^\]]+\]\s*$/, '');
		normalized = collapseWhitespace(normalized);
	}

	return normalized;
}

function removeTrailingParentheticalMetadata(value: string): string {
	let normalized = value;
	let changed = true;

	while (changed) {
		changed = false;

		const next = normalized
			.replace(/\s*\((?:\d{3,4}p|HD|FHD|UHD|SD|UHD\/4K|4K\/UHD)\)\s*$/i, '')
			.replace(/\s*\((?:Geo-blocked|Not 24\/7|Multi-Sub)\)\s*$/i, '')
			.replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, '')
			.replace(/\s*\([A-Z]\)\s*$/, '')
			.replace(/\s*\(\s*\)\s*$/, '');

		const collapsed = collapseWhitespace(next);
		if (collapsed !== normalized) {
			normalized = collapsed;
			changed = true;
		}
	}

	return normalized;
}

function stripLeadingProviderMetadata(value: string, providerType?: LiveTvProviderType): string {
	let normalized = value;

	if (providerType === 'stalker' || providerType === undefined) {
		normalized = normalized.replace(/^\(([A-Z]{2,4}|EXYU|ExYu)\)\s*/, '');
		normalized = normalized.replace(/^(US|UK|CA|AU|NZ|EN):\s*/i, '');
		normalized = normalized.replace(/^-+\s*NO EVENT STREAMING\s*-+\s*\|\s*/i, '');
		normalized = normalized.replace(/^(US|UK|CA|AU|NZ|EN)\s+\([^)]*\)\s+\|\s+/i, '');
		normalized = normalized.replace(/^(US|UK|CA|AU|NZ|EN)\s*\([^)]*\)\s*\|\s*/i, '');
		normalized = normalized.replace(/^\([A-Z]+\s+\d+\)\s*\|\s*[a-z0-9+.-]+:\s*/i, '');

		while (normalized.includes('|')) {
			const pipeIndex = normalized.indexOf('|');
			const prefix = normalized.slice(0, pipeIndex);
			if (!shouldStripPipePrefix(prefix)) {
				break;
			}

			normalized = normalized.slice(pipeIndex + 1).trim();
		}
	}

	return collapseWhitespace(normalized);
}

function removeTechnicalSuffixes(value: string): string {
	let normalized = value;
	let changed = true;

	while (changed) {
		changed = false;
		for (const pattern of TRAILING_TECHNICAL_PATTERNS) {
			if (!pattern.test(normalized)) {
				continue;
			}

			normalized = collapseWhitespace(normalized.replace(pattern, ''));
			changed = true;
		}
	}

	return normalized;
}

function tidyEventArtifacts(value: string): string {
	let normalized = value.replace(/_/g, ' ');
	normalized = normalized.replace(/\s{2,}/g, ' ');
	normalized = normalized.replace(/^24\/7\s+/i, '');
	normalized = normalized.replace(/\s+\/\/+\s+/g, ' - ');
	normalized = normalized.replace(/\s+:\s+Flo College\s+\d+$/i, '');
	normalized = normalized.replace(/^(US|UK|CA|AU|NZ|EN)\s+\([^)]*\)\s+\|\s+/i, '');
	normalized = normalized.replace(/^\([A-Z]+\s+\d+\)\s*\|\s*[a-z0-9+.-]+:\s*/i, '');

	return collapseWhitespace(normalized);
}

export function normalizeLiveTvChannelName(
	name: string,
	providerType?: LiveTvProviderType
): string {
	const fallback = collapseWhitespace(name.normalize('NFKC'));
	if (!fallback) {
		return fallback;
	}

	let normalized = fallback.replace(/#+/g, ' ');
	normalized = tidyEventArtifacts(normalized);
	normalized = stripLeadingProviderMetadata(normalized, providerType);
	normalized = removeTrailingBracketMetadata(normalized);
	normalized = removeTrailingParentheticalMetadata(normalized);
	normalized = removeTechnicalSuffixes(normalized);
	normalized = removeTrailingBracketMetadata(normalized);
	normalized = removeTrailingParentheticalMetadata(normalized);
	normalized = tidyEventArtifacts(normalized);
	normalized = applySmartCasing(normalized);
	normalized = normalized.replace(/\s+\|\s+$/g, '');
	normalized = normalized.replace(/\s+[-:/]+$/g, '');
	normalized = collapseWhitespace(normalized);

	return normalized || fallback;
}
