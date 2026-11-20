/** The shape the Settings → Quality → Music tab renders. */
export interface MusicProfileTierView {
	kind: 'lossless' | 'lossy' | 'streaming';
	label: string;
	formats?: string[];
	minBitrateKbps?: number;
	minBitDepth?: number;
}

export interface MusicProfileView {
	id: string;
	name: string;
	description: string | null;
	tiers: MusicProfileTierView[];
	allowFallback: boolean;
	minSizeMb: number | null;
	maxSizeMb: number | null;
	isDefault: boolean;
	isBuiltIn: boolean;
}
