/**
 * Resolution Category Service (Phase 2)
 *
 * Manages user-editable resolution buckets (4K, 1080p, 720p, SD).
 * Classification normalizes orientation: max(w,h) for width, min(w,h) for
 * height. One fallback category (0x0 thresholds) is required.
 * IDs are immutable — quality profiles reference them.
 */

import { db } from '#lib/server/db/index.js';
import { resolutionCategories } from '#lib/server/db/schema.js';
import { eq, asc } from 'drizzle-orm';

export type ResCategory = typeof resolutionCategories.$inferSelect;

export { resolutionCategories };

export async function getAll(): Promise<ResCategory[]> {
	return db
		.select()
		.from(resolutionCategories)
		.orderBy(asc(resolutionCategories.minWidth), asc(resolutionCategories.minHeight))
		.all();
}

export function classify(
	width: number,
	height: number,
	categories: ResCategory[]
): ResCategory | null {
	const effectiveW = Math.max(width, height);
	const effectiveH = Math.min(width, height);

	let best: ResCategory | null = null;
	for (const cat of categories) {
		const passesWidth = effectiveW >= (cat.minWidth ?? 0);
		const passesHeight = effectiveH >= (cat.minHeight ?? 0);
		if (passesWidth && passesHeight) {
			if (
				!best ||
				(cat.minWidth ?? 0) > (best.minWidth ?? 0) ||
				(cat.minHeight ?? 0) > (best.minHeight ?? 0)
			) {
				best = cat;
			}
		}
	}
	return best;
}

export async function create(input: {
	label: string;
	minWidth?: number;
	minHeight?: number;
	searchTerms?: string[];
	isFallback?: boolean;
}): Promise<ResCategory> {
	const [row] = await db
		.insert(resolutionCategories)
		.values({
			label: input.label,
			minWidth: input.minWidth ?? 0,
			minHeight: input.minHeight ?? 0,
			searchTerms: input.searchTerms ?? [],
			isFallback: input.isFallback ?? false,
			createdAt: new Date().toISOString()
		})
		.returning()
		.all();
	return row!;
}

export async function update(
	id: string,
	input: { label?: string; minWidth?: number; minHeight?: number; searchTerms?: string[] }
): Promise<ResCategory | null> {
	const [row] = await db
		.update(resolutionCategories)
		.set(input)
		.where(eq(resolutionCategories.id, id))
		.returning()
		.all();
	return row ?? null;
}

export async function remove(id: string): Promise<boolean> {
	const cat = await db
		.select()
		.from(resolutionCategories)
		.where(eq(resolutionCategories.id, id))
		.get();
	if (!cat) return false;
	if (cat.isFallback) return false; // Cannot delete the fallback

	await db.delete(resolutionCategories).where(eq(resolutionCategories.id, id));
	return true;
}

/**
 * Ensure exactly one fallback category exists. If none, return null.
 */
export async function getFallback(): Promise<ResCategory | null> {
	return (
		(await db
			.select()
			.from(resolutionCategories)
			.where(eq(resolutionCategories.isFallback, true))
			.limit(1)
			.get()) ?? null
	);
}
