import * as cheerio from 'cheerio';
import { 
    cleanText, 
    parseInteger, 
    parseFloatSafe, 
    parseYear, 
    durationToMinutes, 
    toFullResolutionImage, 
    extractSlug, 
    extractIdFromSlug, 
    parseDateString,
    parseAiredDates 
} from './helpers.js';

export function parseDramaDetails(html, fallbackSlug = '') {
    const $ = cheerio.load(html);

    const titleElem = $('h1.film-title');
    if (!titleElem.length) return null;

    const titleText = cleanText(titleElem.text());
    const completeTitle = titleText;

    const subTitleText = cleanText($('div.film-subtitle').text());
    const year = parseYear(subTitleText) || parseYear(completeTitle);

    // Poster
    const coverImg = $('div.film-cover img, div.col-film-cover img');
    const rawPoster = coverImg.attr('data-src') || coverImg.attr('data-cfsrc') || coverImg.attr('src') || $('meta[property="og:image"]').attr('content') || '';
    const posterHdUrl = toFullResolutionImage(rawPoster);

    // Rating
    const ratingBox = $('div.col-film-rating, div.box.deep-orange, div.hfs');
    const scoreVal = parseFloatSafe(ratingBox.find('b, .score').text()) || parseFloatSafe(ratingBox.text());

    const hfsText = $('div.hfs').text();
    const scoredByMatch = hfsText.match(/([\d,]+)\s+users?/i);
    const scoredBy = scoredByMatch ? parseInteger(scoredByMatch[1]) : null;

    // Synopsis
    let synopsisText = '';
    const synElem = $('div.show-synopsis, div.film-synopsis');
    if (synElem.length) {
        synElem.find('a, button, script, style').remove();
        synopsisText = cleanText(synElem.text());
    }

    // Details sidebar (ul.list or .show-detailsxss)
    let country = '';
    let type = 'Drama';
    let totalEpisodes = null;
    let airedString = '';
    let airedStart = null;
    let airedEnd = null;
    let originalNetwork = null;
    let durationString = '';
    let durationMinutes = null;
    let contentRating = null;
    const alsoKnownAs = [];
    const airedOn = [];
    let nativeTitle = '';

    $('ul.list li.list-item, div.show-detailsxss li').each((_, el) => {
        const bText = cleanText($(el).find('b').first().text()).replace(/:$/, '').trim();
        const clone = $(el).clone();
        clone.find('b').remove();
        const fullVal = cleanText(clone.text());

        switch (bText.toLowerCase()) {
            case 'country':
                country = fullVal;
                break;
            case 'type':
                type = fullVal;
                break;
            case 'episodes':
                totalEpisodes = parseInteger(fullVal);
                break;
            case 'aired':
                airedString = fullVal;
                const dates = parseAiredDates(fullVal);
                airedStart = dates.start;
                airedEnd = dates.end;
                break;
            case 'aired on':
                fullVal.split(',').forEach(d => {
                    const cd = cleanText(d);
                    if (cd && !airedOn.includes(cd)) airedOn.push(cd);
                });
                break;
            case 'original network':
                originalNetwork = fullVal || null;
                break;
            case 'duration':
                durationString = fullVal;
                durationMinutes = durationToMinutes(fullVal);
                break;
            case 'content rating':
                contentRating = fullVal || null;
                break;
            case 'native title':
                nativeTitle = fullVal;
                break;
            case 'also known as':
                $(el).find('a, span').each((__, item) => {
                    const alias = cleanText($(item).text());
                    if (alias && !alsoKnownAs.includes(alias)) alsoKnownAs.push(alias);
                });
                if (alsoKnownAs.length === 0 && fullVal) {
                    fullVal.split(/[,;]/).forEach(a => {
                        const ca = cleanText(a);
                        if (ca && !alsoKnownAs.includes(ca)) alsoKnownAs.push(ca);
                    });
                }
                break;
        }
    });

    // Statistics sidebar
    let ranked = null;
    let popularity = null;
    let watchers = null;
    let favorites = null;

    $('li.list-item').each((_, el) => {
        const text = $(el).text();
        if (text.includes('Ranked:')) {
            const m = text.match(/#([\d,]+)/);
            if (m) ranked = parseInteger(m[1]);
        } else if (text.includes('Popularity:')) {
            const m = text.match(/#([\d,]+)/);
            if (m) popularity = parseInteger(m[1]);
        } else if (text.includes('Watchers:')) {
            const m = text.match(/([\d,]+)/);
            if (m) watchers = parseInteger(m[1]);
        } else if (text.includes('Favorites:')) {
            const m = text.match(/([\d,]+)/);
            if (m) favorites = parseInteger(m[1]);
        }
    });

    // Where to Watch (Streaming Providers)
    const streamingProviders = [];
    $('div.box:contains("Where to Watch") div.block, div.box:contains("Where to Watch") li.list-item, div.block-services a').each((_, el) => {
        const link = $(el).is('a') ? $(el) : $(el).find('a').first();
        const targetUrl = link.attr('href') || '';
        const img = $(el).find('img').first();
        const logo = img.attr('data-src') || img.attr('src') || '';
        const name = cleanText($(el).find('b, a.text-primary').first().text()) || img.attr('alt') || '';
        const typeText = cleanText($(el).find('.p-l div:not(:first-child), div:not(:first-child)').last().text());

        if (name && !streamingProviders.some(p => p.name.toLowerCase() === name.toLowerCase())) {
            streamingProviders.push({
                name,
                url: targetUrl,
                logo_url: logo || undefined,
                type: typeText || 'Subscription'
            });
        }
    });

    // Trailer ID
    const trailerBtn = $('button.btn-trailer, [data-component="watch-trailer"] button, a.btn-trailer');
    const trailerId = trailerBtn.attr('data-id') || null;

    // Photos preview
    const mainPhotos = [];
    $('div.box:contains("Photos") img, .film-photos img, div.film-cover a[href*="/photos/"] img').each((_, img) => {
        const rawSrc = $(img).attr('data-src') || $(img).attr('data-cfsrc') || $(img).attr('src') || '';
        if (rawSrc && !rawSrc.includes('avatar') && !rawSrc.includes('logo') && !rawSrc.includes('assets/img')) {
            const hd = toFullResolutionImage(rawSrc);
            if (!mainPhotos.some(p => p.url === rawSrc || p.hd_url === hd)) {
                mainPhotos.push({
                    url: rawSrc,
                    hd_url: hd,
                    title: cleanText($(img).attr('alt') || $(img).attr('title')) || undefined
                });
            }
        }
    });

    // Genres & Tags
    const genres = [];
    $('li.show-genres a, a[href*="adv=titles&ge="]').each((_, a) => {
        const name = cleanText($(a).text());
        const href = $(a).attr('href') || '';
        const idMatch = href.match(/&ge=([^&]+)/);
        if (name && !genres.some(g => g.name.toLowerCase() === name.toLowerCase())) {
            genres.push({
                name,
                id: idMatch ? idMatch[1] : undefined
            });
        }
    });

    const tags = [];
    $('li.show-tags a, a[href*="adv=titles&th="]').each((_, a) => {
        const name = cleanText($(a).text());
        if (name.includes('Vote tags') || name.includes('(Vote tags)')) return;
        const href = $(a).attr('href') || '';
        const idMatch = href.match(/&th=([^&]+)/);
        if (name && !tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
            tags.push({
                name,
                id: idMatch ? idMatch[1] : undefined
            });
        }
    });

    // Next Episode Countdown
    let nextEpisode = null;
    $('script').each((_, s) => {
        const scriptContent = $(s).html() || '';
        if (scriptContent.includes('var nextEpisodeAiring =')) {
            const match = scriptContent.match(/var nextEpisodeAiring\s*=\s*({[^;]+});/);
            if (match) {
                try {
                    const rawJson = JSON.parse(match[1]);
                    nextEpisode = {
                        episode_number: parseInteger(rawJson.episode_number) || undefined,
                        total_episodes: parseInteger(rawJson.episodes) || undefined,
                        released_at: parseInteger(rawJson.released_at) || undefined,
                        duration: parseInteger(rawJson.duration) || undefined,
                        timezone: rawJson.timezone || undefined
                    };
                } catch {}
            }
        }
    });

    // Related Content
    const relatedContent = [];
    $('li.related-content div.title, div.show-detailsxss li:contains("Related Content") div.title').each((_, div) => {
        const a = $(div).find('a');
        if (!a.length) return;
        const relTitle = cleanText(a.text());
        const relHref = a.attr('href') || '';
        const relSlug = extractSlug(relHref);
        const relFullText = cleanText($(div).text());
        const relation = relFullText.replace(relTitle, '').replace(/[()]/g, '').trim();

        if (relTitle) {
            relatedContent.push({
                title: relTitle,
                slug: relSlug,
                url: `https://mydramalist.com/${relSlug}`,
                relation: relation || 'Related'
            });
        }
    });

    const canonicalLink = $('link[rel="canonical"]').attr('href') || '';
    const resolvedSlug = extractSlug(canonicalLink) || extractSlug(fallbackSlug);
    const resolvedId = extractIdFromSlug(resolvedSlug) || parseInteger($('div.col-film-rating').attr('data-id')) || 0;

    return {
        id: resolvedId,
        slug: resolvedSlug,
        url: `https://mydramalist.com/${resolvedSlug}`,
        title: titleText.replace(/\s*\(\d{4}\)$/, ''),
        complete_title: completeTitle,
        native_title: nativeTitle || undefined,
        sub_title: subTitleText || undefined,
        also_known_as: alsoKnownAs,
        type,
        country,
        year,
        status: totalEpisodes && airedEnd ? (new Date(airedEnd) <= new Date() ? 'Aired' : 'Airing') : 'Aired',
        episodes: totalEpisodes,
        aired_string: airedString,
        aired_start: airedStart,
        aired_end: airedEnd,
        aired_on: airedOn,
        original_network: originalNetwork,
        duration_string: durationString,
        duration_minutes: durationMinutes,
        content_rating: contentRating,
        rating: scoreVal,
        scored_by: scoredBy,
        ranked,
        popularity,
        watchers,
        favorites,
        genres,
        tags,
        synopsis: synopsisText,
        poster_url: rawPoster,
        poster_hd_url: posterHdUrl,
        trailer_id: trailerId,
        trailers: [],
        streaming_providers: streamingProviders,
        photos: mainPhotos,
        reviews: [],
        recommendations: [],
        next_episode: nextEpisode,
        related_content: relatedContent,
        cast: {
            main_roles: [],
            support_roles: [],
            guest_roles: [],
            directors: [],
            screenwriters: [],
            others: []
        },
        episode_list: [],
        scraped_at: new Date().toISOString()
    };
}

export function parseCastPage(html) {
    const $ = cheerio.load(html);
    const section = {
        main_roles: [],
        support_roles: [],
        guest_roles: [],
        directors: [],
        screenwriters: [],
        others: []
    };

    const container = $('div.box.cast-credits, div.cast-credits, div.app-body');

    container.find('h3, h4.header').each((_, h3) => {
        const headerText = cleanText($(h3).text()).toLowerCase();
        const ul = $(h3).next('ul');
        if (!ul.length) return;

        let targetList = section.others;
        let defaultRole = 'Cast';

        if (headerText.includes('main role')) {
            targetList = section.main_roles;
            defaultRole = 'Main Role';
        } else if (headerText.includes('support role')) {
            targetList = section.support_roles;
            defaultRole = 'Support Role';
        } else if (headerText.includes('guest role')) {
            targetList = section.guest_roles;
            defaultRole = 'Guest Role';
        } else if (headerText.includes('director')) {
            targetList = section.directors;
            defaultRole = 'Director';
        } else if (headerText.includes('screenwriter') || headerText.includes('writer')) {
            targetList = section.screenwriters;
            defaultRole = 'Screenwriter';
        }

        ul.find('li.list-item').each((_, li) => {
            const a = $(li).find('a.text-primary, a.name');
            if (!a.length) return;

            const name = cleanText(a.find('b').text()) || cleanText(a.text());
            const href = a.attr('href') || '';
            const slug = extractSlug(href);

            const img = $(li).find('img');
            const rawImg = img.attr('data-src') || img.attr('data-cfsrc') || img.attr('src') || '';
            const hdImg = toFullResolutionImage(rawImg);

            const charElem = $(li).find('small a, div.text-ellipsis small, .character');
            const character = cleanText(charElem.text()) || null;

            const roleElem = $(li).find('small.text-muted, .role');
            const roleType = cleanText(roleElem.text()) || defaultRole;

            if (name) {
                targetList.push({
                    name,
                    slug,
                    url: `https://mydramalist.com/${slug}`,
                    image_url: rawImg,
                    image_hd_url: hdImg,
                    character: character || undefined,
                    role_type: roleType
                });
            }
        });
    });

    return section;
}

export function parseEpisodesPage(html) {
    const $ = cheerio.load(html);
    const episodes = [];

    $('div.episodes div.episode, div.episode-item').each((idx, ep) => {
        const a = $(ep).find('h2.title a, h3.title a, a.title');
        if (!a.length) return;

        const epTitle = cleanText(a.text());
        const href = a.attr('href') || '';
        const slug = extractSlug(href);

        const numMatch = slug.match(/(\d+)$/) || epTitle.match(/episode\s*(\d+)/i);
        const epNum = numMatch ? parseInt(numMatch[1], 10) : (idx + 1);

        const img = $(ep).find('div.cover img, div.thumbnail img, img');
        const rawImg = img.attr('data-src') || img.attr('data-cfsrc') || img.attr('src') || '';
        const hdImg = toFullResolutionImage(rawImg);

        const airDateRaw = cleanText($(ep).find('div.air-date, span.air-date').text());
        const airDate = parseDateString(airDateRaw) || (airDateRaw || null);

        const panel = $(ep).find('div.rating-panel, div.episode-rating');
        const rating = parseFloatSafe(panel.find('b, .score').text());
        const panelText = panel.text();
        const votesMatch = panelText.match(/from\s+([\d,]+)\s+users?/i);
        const votes = votesMatch ? parseInteger(votesMatch[1]) : null;

        const summaryElem = $(ep).find('div.summary, p.summary');
        summaryElem.find('a').each((_, link) => {
            if ($(link).text().toLowerCase().includes('read more')) $(link).remove();
        });
        const summary = cleanText(summaryElem.text()) || null;

        episodes.push({
            episode_number: epNum,
            title: epTitle || `Episode ${epNum}`,
            url: href.startsWith('http') ? href : `https://mydramalist.com/${slug}`,
            air_date: airDate,
            rating,
            votes,
            image_url: rawImg || null,
            image_hd_url: hdImg || null,
            summary
        });
    });

    episodes.sort((a, b) => a.episode_number - b.episode_number);
    return episodes;
}

export function parsePhotosPage(html) {
    const $ = cheerio.load(html);
    const photos = [];

    $('div.box-body img, .photos-list img, div.film-photos img, div.col-xs-6 img, div.col-sm-4 img').each((_, img) => {
        const rawSrc = $(img).attr('data-src') || $(img).attr('data-cfsrc') || $(img).attr('src') || '';
        if (!rawSrc) return;
        if (rawSrc.includes('avatar') || rawSrc.includes('logo') || rawSrc.includes('assets/img')) return;

        const hdUrl = toFullResolutionImage(rawSrc);
        const title = cleanText($(img).attr('alt') || $(img).attr('title')) || undefined;

        if (!photos.some(p => p.url === rawSrc || p.hd_url === hdUrl)) {
            photos.push({
                url: rawSrc,
                hd_url: hdUrl,
                title
            });
        }
    });

    return photos;
}

export function parseReviewsPage(html) {
    const $ = cheerio.load(html);
    const reviews = [];

    $('div.review').each((_, r) => {
        const authorLink = $(r).find('.author a, a.text-primary').first();
        const author = cleanText(authorLink.text());
        const authorHref = authorLink.attr('href') || '';
        const authorUrl = authorHref ? (authorHref.startsWith('http') ? authorHref : `https://mydramalist.com${authorHref}`) : undefined;
        const avatar = $(r).find('img.avatar, .col-xs-2 img, img.rounded').first().attr('src') || undefined;
        const date = cleanText($(r).find('span.datetime').first().text()) || undefined;

        let overall = 10;
        let story;
        let acting;
        let music;
        let rewatch;

        const overallMatch = $(r).find('.rating-overall, .review-rating, .p-t-sm').text().match(/Overall\s*(\d+(?:\.\d+)?)/i);
        if (overallMatch) overall = parseFloat(overallMatch[1]);

        $(r).find('div, span, td, li').each((_, cell) => {
            const txt = cleanText($(cell).text());
            const sm = txt.match(/Story\s*(\d+(?:\.\d+)?)/i);
            if (sm && story === undefined) story = parseFloat(sm[1]);
            const am = txt.match(/Acting\/Cast\s*(\d+(?:\.\d+)?)/i);
            if (am && acting === undefined) acting = parseFloat(am[1]);
            const mm = txt.match(/Music\s*(\d+(?:\.\d+)?)/i);
            if (mm && music === undefined) music = parseFloat(mm[1]);
            const rm = txt.match(/Rewatch Value\s*(\d+(?:\.\d+)?)/i);
            if (rm && rewatch === undefined) rewatch = parseFloat(rm[1]);
        });

        const helpfulText = cleanText($(r).find('.review-helpful, .text-muted').text());
        const helpfulMatch = helpfulText.match(/(\d+)\s+people found this review helpful/i);
        const helpfulVotes = helpfulMatch ? parseInt(helpfulMatch[1], 10) : 0;

        const headline = cleanText($(r).find('.review-headline, h5, h6, b.text-md').first().text()) || undefined;
        
        const bodyClone = $(r).find('.review-body, .text').clone();
        bodyClone.find('a.read-more, .btn, script, style').remove();
        const reviewText = cleanText(bodyClone.text());

        const hasSpoiler = $(r).find('.spoiler, .review-spoiler, .badge-spoiler').length > 0 || reviewText.toLowerCase().includes('spoiler');

        if (author && reviewText) {
            reviews.push({
                author,
                author_url: authorUrl,
                avatar_url: avatar,
                date,
                scores: {
                    overall,
                    story,
                    acting,
                    music,
                    rewatch_value: rewatch
                },
                helpful_votes: helpfulVotes,
                headline,
                review_text: reviewText,
                has_spoiler: hasSpoiler
            });
        }
    });

    return reviews;
}

export function parseRecommendationsPage(html) {
    const $ = cheerio.load(html);
    const recs = [];

    $('.box-body .row, .box-body .media, div.col-xs-12.m-b').each((_, el) => {
        const titleLink = $(el).find('h6.title a, h4.title a, a.text-primary').first();
        const rawTitle = cleanText(titleLink.text());
        const href = titleLink.attr('href') || '';
        const slug = extractSlug(href);

        if (!rawTitle || !slug || slug.includes('recommendation') || slug === 'add_rec') return;

        const year = parseYear(rawTitle) || parseYear($(el).find('.text-muted').text());
        const cleanTitle = rawTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim();

        const img = $(el).find('img').first();
        const posterUrl = img.attr('data-src') || img.attr('src') || '';
        const posterHdUrl = toFullResolutionImage(posterUrl);

        const textBlock = cleanText($(el).text());
        const votesMatch = textBlock.match(/(\d+)\s+users?/i);
        const votes = votesMatch ? parseInt(votesMatch[1], 10) : 0;

        const reasonClone = $(el).find('p, .recommendation-reason, div.text-muted').clone();
        reasonClone.find('a, button, script, style').remove();
        const reason = cleanText(reasonClone.text()) || undefined;

        if (!recs.some(r => r.slug === slug)) {
            recs.push({
                title: cleanTitle || rawTitle,
                slug,
                url: `https://mydramalist.com/${slug}`,
                poster_url: posterUrl,
                poster_hd_url: posterHdUrl,
                year,
                recommendation_reason: reason,
                votes
            });
        }
    });

    return recs;
}

