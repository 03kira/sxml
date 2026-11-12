import { HttpClient } from './client.js';
import { 
    parseDramaDetails, 
    parseCastPage, 
    parseEpisodesPage, 
    parsePhotosPage, 
    parseReviewsPage, 
    parseRecommendationsPage 
} from './parsers.js';
import { extractSlug } from './helpers.js';

export class MdlScraper {
    constructor(options = {}) {
        this.client = new HttpClient(options);
    }

    async getDrama(input, options = {}) {
        const queryStr = String(input).trim();
        let slug = queryStr;
        if (queryStr.startsWith('http')) {
            slug = extractSlug(new URL(queryStr).pathname);
        }

        const includeCast = options.includeCast ?? true;
        const includeEpisodes = options.includeEpisodes ?? true;
        const includeReviews = options.includeReviews ?? true;
        const maxReviewPages = options.maxReviewPages ?? 1;
        const includeRecommendations = options.includeRecommendations ?? true;
        const maxRecPages = options.maxRecPages ?? 5;
        const includePhotos = options.includePhotos ?? true;
        const includeTrailers = options.includeTrailers ?? true;

        // 1. Main Page
        const mainHtml = await this.client.getHtml(slug);
        if (mainHtml === null) {
            // Confirmed 404 Not Found on MDL
            return null;
        }

        const drama = parseDramaDetails(mainHtml, slug);
        if (!drama) {
            throw new Error(`Failed to parse drama structure for slug: "${slug}"`);
        }

        // 2. Trailers API (non-fatal)
        if (includeTrailers && drama.trailer_id) {
            try {
                const trailerJsonStr = await this.client.getHtml(`v1/trailers/${drama.trailer_id}`);
                if (trailerJsonStr) {
                    const trailerData = JSON.parse(trailerJsonStr);
                    const sourceUrl = trailerData?.trailer?.trailer?.source;
                    const thumb = trailerData?.trailer?.thumbnail;
                    if (sourceUrl) {
                        drama.trailers.push({
                            id: drama.trailer_id,
                            title: `${drama.title} Official Trailer`,
                            url: sourceUrl,
                            thumbnail_url: thumb,
                            type: sourceUrl.endsWith('.mp4') ? 'mp4' : 'mdl'
                        });
                    }
                }
            } catch {
                // non-fatal
            }
        }

        // 3. Full Cast & Crew Subpage (Critical: must not be silently skipped on network error)
        if (includeCast) {
            const castHtml = await this.client.getHtml(`${slug}/cast`);
            if (castHtml) {
                drama.cast = parseCastPage(castHtml);
            }
        }

        // 4. Episode Guide Subpage (Critical)
        if (includeEpisodes && drama.type !== 'Movie') {
            const epHtml = await this.client.getHtml(`${slug}/episodes`);
            if (epHtml) {
                drama.episode_list = parseEpisodesPage(epHtml);
            }
        }

        // 5. Photos Gallery Subpage (non-fatal)
        if (includePhotos) {
            try {
                const photosHtml = await this.client.getHtml(`${slug}/photos`);
                if (photosHtml) {
                    const galleryPhotos = parsePhotosPage(photosHtml);
                    for (const gp of galleryPhotos) {
                        if (!drama.photos.some(p => p.url === gp.url || p.hd_url === gp.hd_url)) {
                            drama.photos.push(gp);
                        }
                    }
                }
            } catch {
                // non-fatal
            }
        }

        // 6. Reviews Subpages (non-fatal)
        if (includeReviews) {
            try {
                for (let p = 1; p <= maxReviewPages; p++) {
                    const path = p === 1 ? `${slug}/reviews` : `${slug}/reviews?page=${p}`;
                    const reviewsHtml = await this.client.getHtml(path);
                    if (!reviewsHtml) break;
                    const pageReviews = parseReviewsPage(reviewsHtml);
                    if (pageReviews.length === 0) break;

                    let added = 0;
                    for (const rev of pageReviews) {
                        if (!drama.reviews.some(r => r.author === rev.author && r.scores.overall === rev.scores.overall)) {
                            drama.reviews.push(rev);
                            added++;
                        }
                    }
                    if (added === 0) break;
                }
            } catch {
                // non-fatal
            }
        }

        // 7. Community Recommendations Subpages (non-fatal)
        if (includeRecommendations) {
            try {
                for (let p = 1; p <= maxRecPages; p++) {
                    const path = p === 1 ? `${slug}/recs` : `${slug}/recs?page=${p}`;
                    const recsHtml = await this.client.getHtml(path);
                    if (!recsHtml) break;
                    const pageRecs = parseRecommendationsPage(recsHtml);
                    if (pageRecs.length === 0) break;

                    let added = 0;
                    for (const rec of pageRecs) {
                        if (!drama.recommendations.some(r => r.slug === rec.slug)) {
                            drama.recommendations.push(rec);
                            added++;
                        }
                    }
                    if (added === 0) break;
                }
            } catch {
                // non-fatal
            }
        }

        return drama;
    }
}

