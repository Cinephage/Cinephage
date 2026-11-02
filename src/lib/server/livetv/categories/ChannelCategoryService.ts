/**
 * ChannelCategoryService - Manages user-defined categories for organizing channel lineup.
 */

import { db } from '#lib/server/db/index.js';
import {
	channelCategories,
	channelLineupItems,
	type ChannelCategoryRecord
} from '#lib/server/db/schema.js';
import { eq, asc, sql } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import { randomUUID } from 'node:crypto';
import { liveTvEvents } from '../LiveTvEvents';
import type { ChannelCategory, ChannelCategoryFormData } from '#lib/types/livetv.js';

/**
 * Convert database record to API response
 */
function toCategoryResponse(record: ChannelCategoryRecord): ChannelCategory {
	return {
		id: record.id,
		name: record.name,
		position: record.position,
		color: record.color,
		icon: record.icon,
		createdAt: record.createdAt || new Date().toISOString(),
		updatedAt: record.updatedAt || new Date().toISOString()
	};
}

class ChannelCategoryService {
	/**
	 * Get all categories ordered by position
	 */
	async getCategories(): Promise<ChannelCategory[]> {
		const records = await db
			.select()
			.from(channelCategories)
			.orderBy(asc(channelCategories.position));
		return records.map(toCategoryResponse);
	}

	/**
	 * Get a single category by ID
	 */
	async getCategoryById(id: string): Promise<ChannelCategory | null> {
		const [record] = await db
			.select()
			.from(channelCategories)
			.where(eq(channelCategories.id, id))
			.limit(1);
		return record ? toCategoryResponse(record) : null;
	}

	/**
	 * Get category count
	 */
	async getCategoryCount(): Promise<number> {
		const result = await db.select({ count: sql<number>`count(*)` }).from(channelCategories);
		return result[0]?.count || 0;
	}

	/**
	 * Create a new category
	 */
	async createCategory(data: ChannelCategoryFormData): Promise<ChannelCategory> {
		// Get next position
		const maxPosResult = await db
			.select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
			.from(channelCategories);
		const nextPosition = (maxPosResult[0]?.maxPos || 0) + 1;

		const now = new Date().toISOString();
		const id = randomUUID();

		await db.insert(channelCategories).values({
			id,
			name: data.name,
			position: nextPosition,
			color: data.color || null,
			icon: data.icon || null,
			createdAt: now,
			updatedAt: now
		});

		logger.info({ id, name: data.name }, '[ChannelCategoryService] Created category');
		liveTvEvents.emitCategoriesUpdated();

		return this.getCategoryById(id) as Promise<ChannelCategory>;
	}

	/**
	 * Update a category
	 */
	async updateCategory(id: string, data: ChannelCategoryFormData): Promise<ChannelCategory | null> {
		const now = new Date().toISOString();

		await db
			.update(channelCategories)
			.set({
				name: data.name,
				color: data.color ?? null,
				icon: data.icon ?? null,
				updatedAt: now
			})
			.where(eq(channelCategories.id, id));

		logger.info({ id, name: data.name }, '[ChannelCategoryService] Updated category');
		liveTvEvents.emitCategoriesUpdated();

		return this.getCategoryById(id);
	}

	/**
	 * Delete a category
	 * Lineup items in this category will have their categoryId set to null (via FK)
	 */
	async deleteCategory(id: string): Promise<boolean> {
		const result = await db.delete(channelCategories).where(eq(channelCategories.id, id));

		if (result.changes > 0) {
			logger.info({ id }, '[ChannelCategoryService] Deleted category');
			liveTvEvents.emitCategoriesUpdated();
			return true;
		}
		return false;
	}

	/**
	 * Reorder categories by position
	 */
	async reorderCategories(categoryIds: string[]): Promise<void> {
		const now = new Date().toISOString();

		for (let i = 0; i < categoryIds.length; i++) {
			await db
				.update(channelCategories)
				.set({ position: i + 1, updatedAt: now })
				.where(eq(channelCategories.id, categoryIds[i]));
		}

		logger.info({ count: categoryIds.length }, '[ChannelCategoryService] Reordered categories');
		liveTvEvents.emitCategoriesUpdated();
	}

	/**
	 * Move category up (decrease position)
	 */
	async moveCategoryUp(id: string): Promise<boolean> {
		const category = await this.getCategoryById(id);
		if (!category || category.position <= 1) return false;

		const newPosition = category.position - 1;
		const now = new Date().toISOString();

		// Swap with the category above
		await db
			.update(channelCategories)
			.set({ position: category.position, updatedAt: now })
			.where(eq(channelCategories.position, newPosition));

		await db
			.update(channelCategories)
			.set({ position: newPosition, updatedAt: now })
			.where(eq(channelCategories.id, id));

		liveTvEvents.emitCategoriesUpdated();
		return true;
	}

	/**
	 * Move category down (increase position)
	 */
	async moveCategoryDown(id: string): Promise<boolean> {
		const category = await this.getCategoryById(id);
		if (!category) return false;

		const count = await this.getCategoryCount();
		if (category.position >= count) return false;

		const newPosition = category.position + 1;
		const now = new Date().toISOString();

		// Swap with the category below
		await db
			.update(channelCategories)
			.set({ position: category.position, updatedAt: now })
			.where(eq(channelCategories.position, newPosition));

		await db
			.update(channelCategories)
			.set({ position: newPosition, updatedAt: now })
			.where(eq(channelCategories.id, id));

		liveTvEvents.emitCategoriesUpdated();
		return true;
	}

	/**
	 * Get channel count per category
	 */
	async getCategoryChannelCounts(): Promise<Map<string, number>> {
		const counts = await db
			.select({
				categoryId: channelLineupItems.categoryId,
				count: sql<number>`count(*)`
			})
			.from(channelLineupItems)
			.where(sql`${channelLineupItems.categoryId} IS NOT NULL`)
			.groupBy(channelLineupItems.categoryId);

		const map = new Map<string, number>();
		for (const row of counts) {
			if (row.categoryId) {
				map.set(row.categoryId, row.count);
			}
		}
		return map;
	}
}

// Singleton instance
let categoryServiceInstance: ChannelCategoryService | null = null;

export function getChannelCategoryService(): ChannelCategoryService {
	if (!categoryServiceInstance) {
		categoryServiceInstance = new ChannelCategoryService();
	}
	return categoryServiceInstance;
}

// Backward compatibility export
export const channelCategoryService = getChannelCategoryService();
