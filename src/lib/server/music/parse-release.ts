/**
 * Music release-name parsing and grading.
 *
 * The video `ReleaseParser` is not reusable here: it looks for resolution,
 * codecs and HDR, none of which exist in an album name. What a music release
 * name carries is format, bitrate, bit depth / sample rate, source and year —
 * "Daft Punk - Discovery (2001) [24-96 Hi Res] [FLAC]".
 *
 * Grading is **tier first, score second**: a profile is an ordered ladder of
 * acceptable qualities, and a release takes the highest rung it satisfies. That
 * is what makes falling back to a lower quality a profile decision rather than a
 * seeders heuristic — rung 2 is only used when nothing matched rung 1.
 */

export type MusicFormat = 'flac' | 'alac' | 'wav' | 'mp3' | 'aac' | 'ogg' | 'opus' | 'unknown';

export interface ParsedMusicRelease {
	format: MusicFormat;
	/** True for lossless formats (flac/alac/wav). */
	lossless: boolean;
	/** kbps for lossy releases; null for lossless or unknown. */
	bitrateKbps: number | null;
	/** VBR quality marker when present (V0/V2). */
	vbrQuality: string | null;
	bitDepth: number | null;
	/** kHz, as printed in the name (44.1, 96…). */
	sampleRateKhz: number | null;
	/** Vinyl, CD, WEB, SACD… when the name says so. */
	source: string | null;
	year: number | null;
}

const FORMAT_PATTERNS: Array<[MusicFormat, RegExp]> = [
	['flac', /\bflac\b/i],
	['alac', /\balac\b/i],
	['wav', /\bwav\b/i],
	['mp3', /\bmp3\b/i],
	['aac', /\baac\b|\bm4a\b/i],
	['ogg', /\bogg\b/i],
	['opus', /\bopus\b/i]
];

const LOSSLESS: ReadonlySet<MusicFormat> = new Set<MusicFormat>(['flac', 'alac', 'wav']);

const SOURCE_PATTERNS: Array<[string, RegExp]> = [
	['vinyl', /\bvinyl\b|\blp\b|\bpbthal\b/i],
	['sacd', /\bsacd\b/i],
	['cd', /\bcd\b|\bcdrip\b|\bredbook\b/i],
	['web', /\bweb\b|\bwebrip\b|\bweb-dl\b|\bitunes\b/i],
	['bluray', /\bblu-?ray\b/i],
	['dvd', /\bdvd\b/i]
];

/**
 * Parse a music release name. Deliberately permissive: a name that states
 * nothing is still a usable candidate, it just matches the lowest tier.
 */
export function parseMusicRelease(title: string): ParsedMusicRelease {
	const format = FORMAT_PATTERNS.find(([, pattern]) => pattern.test(title))?.[0] ?? 'unknown';
	const lossless = LOSSLESS.has(format);

	// 24-96 / 16-44.1 must be read before a bare bitrate rule, or "24" would be
	// taken for a 24 kbps bitrate.
	let bitDepth: number | null = null;
	let sampleRateKhz: number | null = null;
	const depthRate = /\b(16|24|32)\s*[-/x ]\s*(44\.1|48|88\.2|96|176\.4|192|352\.8)\b/i.exec(title);
	if (depthRate) {
		bitDepth = Number(depthRate[1]);
		sampleRateKhz = Number(depthRate[2]);
	} else {
		const bitDepthOnly = /\b(16|24|32)\s*-?bit\b/i.exec(title);
		if (bitDepthOnly) bitDepth = Number(bitDepthOnly[1]);
	}

	// A bare 320 next to a codec is the normal spelling ("Mp3 320"); years are
	// four digits so they cannot collide with this list.
	const bitrate = /\b(128|160|192|224|256|320)[\s._-]*kbps\b|\b(128|160|192|224|256|320)\b/i.exec(
		title
	);
	const vbr = /\bv(0|2)\b/i.exec(title);

	return {
		format,
		lossless,
		bitrateKbps: lossless ? null : bitrate ? Number(bitrate[1] ?? bitrate[2]) : null,
		vbrQuality: vbr ? `V${vbr[1]}` : null,
		bitDepth,
		sampleRateKhz,
		source: SOURCE_PATTERNS.find(([, pattern]) => pattern.test(title))?.[0] ?? null,
		year: Number(/\b(19|20)\d{2}\b/.exec(title)?.[0] ?? 0) || null
	};
}

/**
 * One rung of the quality ladder. A release matches when every stated condition
 * holds; omitted conditions are ignored.
 */
export type MusicTierKind = 'lossless' | 'lossy' | 'streaming';

export interface MusicTier {
	/** Installed tiers say what they are; code-defined profiles may omit it. */
	kind?: MusicTierKind;
	label: string;
	formats?: MusicFormat[];
	lossless?: boolean;
	minBitDepth?: number;
	minBitrateKbps?: number;
}

/**
 * A music quality profile.
 *
 * `tiers` is the whole quality policy, ordered best first. `allowFallback`
 * decides whether a lower rung is acceptable when nothing matches a higher one —
 * the "grab what exists" switch. `formatScores` only breaks ties *inside* a tier
 * (a vinyl rip over a web rip of the same rung).
 */
export interface MusicQualityProfile {
	id: string;
	name: string;
	tiers: MusicTier[];
	allowFallback: boolean;
	formatScores: Record<string, number>;
	minSizeMb?: number | null;
	maxSizeMb?: number | null;
}

export interface MusicGrade {
	score: number;
	accepted: boolean;
	/** Index into `profile.tiers`; -1 when nothing matched. */
	tierIndex: number;
	tierLabel: string | null;
	reasons: string[];
	parsed: ParsedMusicRelease;
}

/**
 * Lossless-first ladder, falling back one rung at a time — how people actually
 * collect: hi-res, then any lossless, then high-bitrate lossy, then whatever
 * exists.
 */
export const DEFAULT_MUSIC_PROFILE: MusicQualityProfile = {
	id: 'music-default',
	name: 'Lossless first',
	allowFallback: true,
	tiers: [
		{ kind: 'lossless', label: 'Lossless 24-bit', lossless: true, minBitDepth: 24 },
		{ kind: 'lossless', label: 'Lossless', lossless: true },
		{
			kind: 'lossy',
			label: 'High-bitrate lossy',
			formats: ['mp3', 'aac'],
			lossless: false,
			minBitrateKbps: 256
		},
		// Explicit formats: an unparseable name is "unknown", and accepting it as
		// lossy would let a release nobody could identify rank as real audio.
		{ kind: 'lossy', label: 'Lossy', formats: ['mp3', 'aac', 'ogg', 'opus'], lossless: false },
		// The fallback that makes an album with no torrent playable at all.
		{ kind: 'streaming', label: 'Streaming' }
	],
	formatScores: {
		'format-flac': 40,
		'format-alac': 35,
		'format-wav': 30,
		'format-mp3': 10,
		'format-aac': 8,
		'format-ogg': 4,
		'format-opus': 3,
		'format-unknown': 0,
		'source-vinyl': 12,
		'source-sacd': 10,
		'source-cd': 8,
		'source-web': 6,
		'source-bluray': 5,
		'source-dvd': 3
	}
};

/** Size of the audio payload, in MB, as the release reports it. */
export function releaseSizeMb(sizeBytes: number | null | undefined): number | null {
	if (!sizeBytes || sizeBytes <= 0) return null;
	return sizeBytes / (1024 * 1024);
}

function matchesTier(tier: MusicTier, parsed: ParsedMusicRelease): boolean {
	// A streaming rung never matches a torrent/usenet release: it is selected by
	// protocol, not by a codec in the name.
	if (tier.kind === 'streaming') return false;
	if (tier.formats && !tier.formats.includes(parsed.format)) return false;
	if (tier.lossless !== undefined && tier.lossless !== parsed.lossless) return false;
	if (tier.minBitDepth !== undefined && (parsed.bitDepth ?? 0) < tier.minBitDepth) return false;
	if (tier.minBitrateKbps !== undefined && (parsed.bitrateKbps ?? 0) < tier.minBitrateKbps)
		return false;
	return true;
}

/**
 * Grade one candidate: first matching tier, then a tie-break score inside it.
 *
 * Seeders are deliberately not consulted. Availability is not quality, and a
 * well-seeded lossy rip must not outrank a sparse lossless one — when nothing
 * better exists, `allowFallback` lowers the bar, not the swarm size.
 */
export function gradeMusicRelease(
	profile: MusicQualityProfile,
	release: { title: string; size?: number | null; protocol?: string | null }
): MusicGrade {
	const parsed = parseMusicRelease(release.title);

	// A streaming release has no codec or bitrate in its name — the source
	// decides those at playback. It is a rung of its own: a profile that lists a
	// streaming tier accepts it at that rung, and a profile that does not (FLAC
	// only) rejects it outright. That is the difference between "all FLAC" and
	// "just streaming".
	if (release.protocol === 'streaming') {
		const streamingIndex = profile.tiers.findIndex((tier) => tier.kind === 'streaming');
		if (streamingIndex < 0) {
			return {
				score: 0,
				accepted: false,
				tierIndex: -1,
				tierLabel: null,
				reasons: [`"${profile.name}" does not allow streaming`],
				parsed
			};
		}

		const rung = profile.tiers[streamingIndex];
		return {
			score: Math.max(1, (profile.tiers.length - streamingIndex) * 10),
			accepted: true,
			tierIndex: streamingIndex,
			tierLabel: rung.label,
			reasons: [],
			parsed
		};
	}

	const reasons: string[] = [];

	const tierIndex = profile.tiers.findIndex((tier) => matchesTier(tier, parsed));
	const tier = tierIndex >= 0 ? profile.tiers[tierIndex] : null;

	let accepted = tierIndex >= 0;
	if (!tier) {
		reasons.push(
			parsed.format === 'unknown' && parsed.bitrateKbps
				? `the name states ${parsed.bitrateKbps} kbps but no codec, so no quality tier can grade it`
				: `no quality tier matches ${parsed.format === 'unknown' ? 'an' : 'a'} ${parsed.format} release`
		);
	} else if (!profile.allowFallback && tierIndex > 0) {
		accepted = false;
		reasons.push(`only matches "${tier.label}"; fallback is off`);
	}

	const sizeMb = releaseSizeMb(release.size ?? null);
	if (sizeMb !== null && profile.minSizeMb && sizeMb < profile.minSizeMb) {
		accepted = false;
		reasons.push(`${sizeMb.toFixed(0)} MB below the ${profile.minSizeMb} MB floor`);
	}
	if (sizeMb !== null && profile.maxSizeMb && sizeMb > profile.maxSizeMb) {
		accepted = false;
		reasons.push(`${sizeMb.toFixed(0)} MB above the ${profile.maxSizeMb} MB ceiling`);
	}

	let score = profile.formatScores[`format-${parsed.format}`] ?? 0;
	if (parsed.source) score += profile.formatScores[`source-${parsed.source}`] ?? 0;
	// Higher tiers are worth more, so the number stays meaningful across a ladder.
	score += Math.max(0, profile.tiers.length - tierIndex) * 10;

	return { score, accepted, tierIndex, tierLabel: tier?.label ?? null, reasons, parsed };
}
