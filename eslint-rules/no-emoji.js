/**
 * Local ESLint rule: no-emoji
 *
 * Disallows pictographic emoji anywhere in a linted source file - string
 * literals, template literals, comments, AND Svelte template markup. Emoji in
 * code/PRs is the most widely recognized low-quality / AI-generated tell, and
 * they render as tofu boxes on systems without an emoji font.
 *
 * Scope is deliberately narrow: only what people colloquially call "emoji"
 * (the high pictographic Unicode planes plus a few BMP emoji-presentation
 * characters). Unicode *symbols* that Google's JS style guide explicitly
 * endorses as readable (arrows like `→`, `★`, `✓`, `✗`, `⚠`, `♪`) are NOT
 * banned - they are not the AI tell and render widely. Escapes such as
 * `\u266A` are allowed because the raw source text contains the six characters
 * `\`,`u`,`2`,`6`,`6`,`A` and no actual emoji codepoint.
 *
 * The rule scans the full raw source text (not AST nodes) so that Svelte
 * template markup (e.g. a pictographic glyph placed directly inside an element)
 * is caught as well as script content.
 */

const PICTOGRAPHIC_RANGES = [
	[0x1f000, 0x1f0ff], // mahjong, dominoes, playing cards
	[0x1f1e6, 0x1f1ff], // regional indicator letters (flag pairs)
	[0x1f300, 0x1faff] // emoticons, misc symbols & pictographs, transport, supplemental symbols
];

// BMP characters outside the high planes that nonetheless render as emoji.
const EXPLICIT_EMOJI_CODEPOINTS = new Set([
	0x2705, // U+2705 white heavy check mark
	0x274c, // U+274C cross mark
	0x2728, // U+2728 sparkles
	0x2764, // U+2764 heavy black heart
	0x2b50 // U+2B50 white medium star
]);

function isBannedEmoji(cp) {
	if (EXPLICIT_EMOJI_CODEPOINTS.has(cp)) return true;
	for (const [lo, hi] of PICTOGRAPHIC_RANGES) {
		if (cp >= lo && cp <= hi) return true;
	}
	return false;
}

export default {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow pictographic emoji anywhere in source (code, comments, Svelte markup)'
		},
		schema: [],
		messages: {
			emoji:
				'Pictographic emoji are not allowed in source (found U+{{cp}}). Emoji in code/PRs is a common low-quality signal and renders inconsistently; use text, an icon component, or a \\u escape. Unicode symbols (arrows, stars, check marks) are fine - only pictographic emoji are banned.'
		}
	},
	create(context) {
		const text = context.sourceCode.text;
		const lines = text.split(/\r?\n/);

		return {
			Program() {
				for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
					const line = lines[lineIndex];
					// ESLint columns are 0-based and counted in UTF-16 code units.
					for (let column = 0; column < line.length;) {
						const cp = line.codePointAt(column);
						if (isBannedEmoji(cp)) {
							context.report({
								loc: { line: lineIndex + 1, column },
								messageId: 'emoji',
								data: { cp: cp.toString(16).toUpperCase().padStart(4, '0') }
							});
						}
						column += cp > 0xffff ? 2 : 1;
					}
				}
			}
		};
	}
};
