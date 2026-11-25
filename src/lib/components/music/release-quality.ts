/**
 * How a music release's quality reads in a row.
 *
 * The name often states a bitrate without a codec ("320_kbps Beats"), so
 * "UNKNOWN" is the wrong label — the number is known, the codec is not. Both
 * the album page and the track modal render this, so it lives once.
 */
export interface ReleaseQualityFields {
	format?: string | null;
	bitDepth?: number | null;
	sampleRateKhz?: number | null;
	bitrateKbps?: number | null;
}

const LOSSLESS = new Set(['flac', 'alac', 'wav']);

export function musicQualityLabel(release: ReleaseQualityFields): string {
	const format = (release.format ?? 'unknown').toLowerCase();

	if (format === 'unknown') {
		return release.bitrateKbps ? `${release.bitrateKbps} kbps · codec?` : 'Unknown';
	}

	const depth = release.bitDepth ? ` ${release.bitDepth}-bit` : '';
	const rate = release.sampleRateKhz ? `/${release.sampleRateKhz}` : '';
	const bitrate = !LOSSLESS.has(format) && release.bitrateKbps ? ` ${release.bitrateKbps}` : '';

	return `${format.toUpperCase()}${depth}${rate}${bitrate}`;
}
