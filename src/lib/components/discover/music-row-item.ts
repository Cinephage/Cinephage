/** The music row shape the Discover surfaces hand to MusicRowCard. */
export type MusicRowItem = {
	id: string;
	title?: string;
	subtitle?: string | null;
	image_url?: string | null;
	media_type: 'music';
};
