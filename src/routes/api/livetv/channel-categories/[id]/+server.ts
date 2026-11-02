/**
 * Single Channel Category API
 *
 * GET /api/livetv/channel-categories/[id] - Get single category
 * PUT /api/livetv/channel-categories/[id] - Update category
 * DELETE /api/livetv/channel-categories/[id] - Delete category
 */

import type { RequestHandler } from './$types';
import { channelCategoryService } from '#lib/server/livetv/categories/index.js';
import { ValidationError } from '#lib/errors/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { ChannelCategoryFormData } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvChannelCategoryById', logDomain: 'livetv' });

export const GET: RequestHandler = async ({ params }) => {
	try {
		const category = await channelCategoryService.getCategoryById(params.id);

		if (!category) {
			return Response.json(
				{
					success: false,
					error: 'Category not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			category
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get channel category',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get channel category'
			},
			{ status: 500 }
		);
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	try {
		const body = (await request.json()) as ChannelCategoryFormData;

		if (!body.name || typeof body.name !== 'string') {
			throw new ValidationError('name is required');
		}

		const category = await channelCategoryService.updateCategory(params.id, {
			name: body.name.trim(),
			color: body.color,
			icon: body.icon
		});

		if (!category) {
			return Response.json(
				{
					success: false,
					error: 'Category not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true,
			category
		});
	} catch (error) {
		// Validation errors
		if (error instanceof ValidationError) {
			return Response.json(
				{
					success: false,
					error: error.message,
					code: error.code
				},
				{ status: error.statusCode }
			);
		}
		logger.error(
			'[API] Failed to update channel category',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to update channel category'
			},
			{ status: 500 }
		);
	}
};

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		const success = await channelCategoryService.deleteCategory(params.id);

		if (!success) {
			return Response.json(
				{
					success: false,
					error: 'Category not found'
				},
				{ status: 404 }
			);
		}

		return Response.json({
			success: true
		});
	} catch (error) {
		logger.error(
			'[API] Failed to delete channel category',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to delete channel category'
			},
			{ status: 500 }
		);
	}
};
