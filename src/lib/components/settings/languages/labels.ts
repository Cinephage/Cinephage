import * as m from '#lib/paraglide/messages.js';
import type { SubtitleAccessibility, SubtitleVariant } from '#lib/shared/language-profile.js';

/** Localized display label for a subtitle variant. */
export function variantLabel(variant: SubtitleVariant): string {
	switch (variant) {
		case 'regular':
			return m.settings_languages_profiles_variantRegular();
		case 'forced':
			return m.settings_languages_profiles_variantForced();
		case 'both':
			return m.settings_languages_profiles_variantBoth();
	}
}

/** Localized display label for a subtitle accessibility preference. */
export function accessibilityLabel(accessibility: SubtitleAccessibility): string {
	switch (accessibility) {
		case 'any':
			return m.settings_languages_profiles_accessibilityAny();
		case 'prefer-hi':
			return m.settings_languages_profiles_accessibilityPreferHi();
		case 'require-hi':
			return m.settings_languages_profiles_accessibilityRequireHi();
		case 'exclude-hi':
			return m.settings_languages_profiles_accessibilityExcludeHi();
	}
}
