/** One row of a music release search, shared by the three release tables. */
export interface ReleaseRow {
	guid: string | null;
	title: string;
	indexerName: string | null;
	size: number | null;
	seeders: number | null;
	format?: string;
	bitDepth?: number | null;
	sampleRateKhz?: number | null;
	bitrateKbps?: number | null;
	accepted?: boolean;
	tierLabel?: string | null;
	reasons?: string[];
}
