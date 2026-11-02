/**
 * Language Class - Based on Bazarr/Subliminal architecture
 *
 * Rich language representation with forced/HI as first-class attributes.
 * Language conversion to provider-specific codes lives inside each provider
 * adapter (see src/lib/server/subtitles/providers/*).
 */

import { canonicalizeLanguageTag, getLanguageDefinition } from '#lib/shared/languages.js';
import type { LanguageCode } from './types';

/**
 * Language class with forced/hearing impaired as first-class attributes
 *
 * Based on Bazarr's subzero/language.py Language class
 */
export class Language {
	/** ISO 639-1 code (2-letter) */
	readonly alpha2: string;

	/** ISO 639-2 code (3-letter) */
	readonly alpha3: string;

	/** English name */
	readonly name: string;

	/** Native name */
	readonly nativeName?: string;

	/** Country/region code (e.g., 'BR' for pt-BR) */
	readonly country?: string;

	/** Script variant (e.g., 'Latn', 'Cyrl') */
	readonly script?: string;

	/** Whether this is forced subtitles */
	forced: boolean;

	/** Whether this is for hearing impaired (SDH/CC) */
	hi: boolean;

	constructor(alpha2: string, options: LanguageOptions = {}) {
		const canonical = canonicalizeLanguageTag(alpha2) || alpha2.trim().toLowerCase();
		const [base, ...subtags] = canonical.split('-');
		const region = subtags.find((part) => part.length === 2);
		const scriptPart = subtags.find((part) => part.length === 4);

		this.alpha2 = base;
		this.forced = options.forced ?? false;
		this.hi = options.hi ?? false;
		this.country = options.country ?? (region ? region.toUpperCase() : undefined);
		this.script = options.script ?? (scriptPart ? scriptPart : undefined);

		const langDef = getLanguageDefinition(canonical);
		this.alpha3 = langDef?.alpha3B ?? this.alpha2;
		this.name = langDef?.name ?? canonical;
		this.nativeName = langDef?.nativeName;
	}

	/**
	 * Create Language from any recognized code (ISO 639-1/2/3 or alias)
	 */
	static fromCode(code: string, options: LanguageOptions = {}): Language {
		return new Language(code, options);
	}

	/**
	 * Create Language from alpha3 (ISO 639-2) code
	 */
	static fromAlpha3(alpha3: string, options: LanguageOptions = {}): Language {
		return Language.fromCode(alpha3, options);
	}

	/**
	 * Create a new Language with modified attributes (like Bazarr's rebuild)
	 */
	rebuild(overrides: Partial<LanguageOptions> = {}): Language {
		return new Language(this.alpha2, {
			forced: overrides.forced ?? this.forced,
			hi: overrides.hi ?? this.hi,
			country: overrides.country ?? this.country,
			script: overrides.script ?? this.script
		});
	}

	/**
	 * Create forced variant
	 */
	toForced(): Language {
		return this.rebuild({ forced: true, hi: false });
	}

	/**
	 * Create hearing impaired variant
	 */
	toHearingImpaired(): Language {
		return this.rebuild({ hi: true, forced: false });
	}

	/**
	 * Create regular (non-forced, non-HI) variant
	 */
	toRegular(): Language {
		return this.rebuild({ forced: false, hi: false });
	}

	/**
	 * Check equality (including forced/hi attributes)
	 */
	equals(other: Language): boolean {
		return (
			this.alpha2 === other.alpha2 &&
			this.country === other.country &&
			this.script === other.script &&
			this.forced === other.forced &&
			this.hi === other.hi
		);
	}

	/**
	 * Check if languages are equivalent (ignoring forced/hi)
	 */
	isEquivalent(other: Language): boolean {
		return (
			this.alpha2 === other.alpha2 && this.country === other.country && this.script === other.script
		);
	}

	/**
	 * Get string representation for display
	 */
	toString(): string {
		let result = this.name;
		if (this.country) {
			result += ` (${this.country})`;
		}
		if (this.forced) {
			result += ' [Forced]';
		}
		if (this.hi) {
			result += ' [HI]';
		}
		return result;
	}

	/**
	 * Get code for file naming
	 */
	toFileCode(): string {
		let code = this.alpha2;
		if (this.country) {
			code += `-${this.country.toLowerCase()}`;
		}
		if (this.forced) {
			code += '.forced';
		}
		if (this.hi) {
			code += '.hi';
		}
		return code;
	}

	/**
	 * Get canonical code (base + script + country) used for comparisons
	 */
	get code(): LanguageCode {
		let code = this.alpha2;
		if (this.script) {
			code += `-${this.script}`;
		}
		if (this.country) {
			code += `-${this.country}`;
		}
		return code;
	}

	/**
	 * Parse language from string (e.g., "en", "pt-br", "zh-cn", "en.forced", "en.hi")
	 */
	static parse(input: string): Language {
		const parts = input.toLowerCase().split('.');
		const [langPart, ...flags] = parts;

		const forced = flags.includes('forced') || flags.includes('force');
		const hi = flags.includes('hi') || flags.includes('sdh') || flags.includes('cc');

		return new Language(langPart, { forced, hi });
	}
}

/**
 * Language constructor options
 */
export interface LanguageOptions {
	forced?: boolean;
	hi?: boolean;
	country?: string;
	script?: string;
}

/**
 * Language equivalence pair
 *
 * Shape used by the subtitle pool to treat certain language pairs as equal
 * (e.g. `pt-br` ↔ `pt`).
 */
export interface LanguageEquivalencePair {
	from: string;
	to: string;
}
