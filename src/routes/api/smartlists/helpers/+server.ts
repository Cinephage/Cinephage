/**
 * Smart List Helpers API
 * GET /api/smartlists/helpers - Get filter helper data (genres, providers, etc.)
 */

import type { RequestHandler } from './$types';
import { tmdb } from '#lib/server/tmdb.js';

export const GET: RequestHandler = async ({ url }) => {
	const type = url.searchParams.get('type') as 'movie' | 'tv' | null;
	const helper = url.searchParams.get('helper');
	const query = url.searchParams.get('q') ?? '';
	const region = url.searchParams.get('region') ?? (await tmdb.getRegion());

	if (!helper) {
		return Response.json({ error: 'Missing helper parameter' }, { status: 400 });
	}

	try {
		switch (helper) {
			case 'genres': {
				if (!type) {
					return Response.json({ error: 'Missing type parameter for genres' }, { status: 400 });
				}
				const result = type === 'movie' ? await tmdb.getMovieGenres() : await tmdb.getTvGenres();
				return Response.json(result.genres);
			}

			case 'providers': {
				if (!type) {
					return Response.json({ error: 'Missing type parameter for providers' }, { status: 400 });
				}
				const result = await tmdb.getWatchProviders(type, region);
				return Response.json(result.results);
			}

			case 'certifications': {
				if (!type) {
					return Response.json(
						{ error: 'Missing type parameter for certifications' },
						{ status: 400 }
					);
				}
				const result = await tmdb.getCertifications(type);
				// Return US certifications by default, or specified country
				const country = url.searchParams.get('country') ?? region;
				return Response.json(result.certifications[country] ?? []);
			}

			case 'keywords': {
				if (!query) {
					return Response.json(
						{ error: 'Missing q parameter for keyword search' },
						{ status: 400 }
					);
				}
				const result = await tmdb.searchKeywords(query);
				return Response.json(result.results);
			}

			case 'people': {
				if (!query) {
					return Response.json({ error: 'Missing q parameter for people search' }, { status: 400 });
				}
				const result = await tmdb.searchPeople(query);
				return Response.json(result.results);
			}

			case 'companies': {
				if (!query) {
					return Response.json(
						{ error: 'Missing q parameter for company search' },
						{ status: 400 }
					);
				}
				const result = await tmdb.searchCompanies(query);
				return Response.json(result.results);
			}

			case 'languages': {
				const result = await tmdb.getLanguages();
				return Response.json(result);
			}

			case 'countries': {
				const result = await tmdb.getCountries();
				return Response.json(result);
			}

			default:
				return Response.json({ error: `Unknown helper: ${helper}` }, { status: 400 });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json({ error: message }, { status: 500 });
	}
};
