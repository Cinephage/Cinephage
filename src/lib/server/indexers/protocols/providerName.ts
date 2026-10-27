/**
 * Provider-name matching for gateway streaming sources.
 *
 * The gateway labels a provider with a rendition/source suffix, e.g.
 * "Cno (2160p)", "Vidy (1080p)" or "Vidlove (MovieBox2)". The suffix identifies
 * a sub-source and varies between responses, so provider identity is the base
 * name before the first parenthesis, compared case-insensitively.
 *
 * Matching is prefix-based: a configured entry of "cno" matches "Cno (2160p)"
 * and a configured full label such as "Cno (1080p)" matches every other Cno
 * rendition. This replaces equality matching, which silently stopped matching
 * once the gateway started appending the suffix.
 */

/**
 * Base provider name: text before the first parenthesis, trimmed and lowercased.
 * "Cno (2160p)" -> "cno"; "Vidlink" -> "vidlink".
 */
export function providerFamily(provider: string | undefined | null): string {
	if (!provider) return '';
	const base = provider.split('(', 1)[0] ?? '';
	return base.trim().toLowerCase();
}

/**
 * True when `provider` belongs to the same family as `expected`.
 *
 * Both sides are reduced to their family first, so a configured full label
 * ("Cno (1080p)") matches a different rendition ("Cno (2160p)"). A family
 * matches when either is a prefix of the other, which keeps short configured
 * ids ("cinephage") working against longer gateway names.
 */
export function providerMatches(
	provider: string | undefined | null,
	expected: string | undefined | null
): boolean {
	const family = providerFamily(provider);
	const target = providerFamily(expected);
	if (!family || !target) return false;
	return family.startsWith(target) || target.startsWith(family);
}
