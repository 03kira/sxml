/**
 * Standalone JSON-based MDL Deep Detail Enrichment Engine
 * Optimized for GitHub Actions and local execution without native dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MdlScraper } from './scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SEARCH_DIR = path.join(DATA_DIR, 'search');
const ENRICHED_DIR = path.join(DATA_DIR, 'enriched');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'checkpoint.json');

// Local fallback to MDL_DB if running in the workspace
const LOCAL_MDL_DB = path.resolve(__dirname, '../../MDL/MDL_DB');

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SEARCH_DIR)) fs.mkdirSync(SEARCH_DIR, { recursive: true });
    if (!fs.existsSync(ENRICHED_DIR)) fs.mkdirSync(ENRICHED_DIR, { recursive: true });
}

function loadCheckpoint() {
    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        } catch {}
    }
    return {};
}

function saveCheckpoint(state) {
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function loadSearchIndex(year) {
    const localFile = path.join(SEARCH_DIR, `mdl_search_${year}.json`);
    if (fs.existsSync(localFile)) {
        return JSON.parse(fs.readFileSync(localFile, 'utf8'));
    }

    // Try fallback to MDL_DB search file if running in local repository
    const fallbackFile = path.join(LOCAL_MDL_DB, `mdl_search_${year}.json`);
    if (fs.existsSync(fallbackFile)) {
        console.log(`ℹ️ Using search index from local MDL_DB: mdl_search_${year}.json`);
        return JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
    }

    return null;
}

function loadEnrichedArchive(year) {
    const enrichedFile = path.join(ENRICHED_DIR, `mdl_enriched_${year}.json`);
    const map = new Map();

    if (fs.existsSync(enrichedFile)) {
        try {
            const arr = JSON.parse(fs.readFileSync(enrichedFile, 'utf8'));
            for (const item of arr) {
                if (item && item.id) map.set(item.id, item);
            }
        } catch (e) {
            console.warn(`Warning reading ${enrichedFile}: ${e.message}`);
        }
    } else {
        // Fallback to existing enriched file in MDL_DB if available
        const fallbackFile = path.join(LOCAL_MDL_DB, `mdl_enriched_${year}.json`);
        if (fs.existsSync(fallbackFile)) {
            try {
                const arr = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
                for (const item of arr) {
                    if (item && item.id) map.set(item.id, item);
                }
                console.log(`ℹ️ Seeded ${map.size} existing dossiers from MDL_DB/mdl_enriched_${year}.json`);
            } catch {}
        }
    }

    return { filePath: enrichedFile, map };
}

function flushEnriched(filePath, map) {
    const arr = Array.from(map.values());
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8');
}

function randomDelay(min = 1200, max = 2000) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function enrichTitle(scraper, item) {
    const startTime = Date.now();
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const drama = await scraper.getDrama(item.slug || item.id, {
                includeCast: true,
                includeEpisodes: true,
                includePhotos: true,
                includeTrailers: true,
                includeReviews: true,
                includeRecommendations: true
            });

            if (drama === null) {
                // Verified 404 Not Found on MDL
                console.log(`[Enricher] ⚠️ 404 Not Found on MDL: "${item.title}" (ID: ${item.id}). Skipped.`);
                return { notFound: true, drama: null };
            }

            if (!drama.id || !drama.slug || !drama.title) {
                throw new Error(`Corrupted drama schema returned for "${item.title}"`);
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const castCount = (drama.cast?.main_roles?.length || 0) + (drama.cast?.support_roles?.length || 0);
            const epsCount = drama.episode_list?.length || drama.episodes || 0;
            const scoreStr = drama.rating ? drama.rating.toFixed(1) : '-';

            console.log(`✅ (${drama.year || 'N/A'}) "${drama.title}" | Cast: ${castCount}, Eps: ${epsCount} | ⭐ ${scoreStr} | ${elapsed}s`);
            return { notFound: false, drama };
        } catch (err) {
            console.warn(`[Enricher] ⚠️ Attempt ${attempt}/${maxAttempts} failed for "${item.title}": ${err.message}`);
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, attempt * 2500));
            } else {
                console.error(`[Enricher] ❌ Retries exhausted for "${item.title}". Left pending (NO half-data written).`);
                return { notFound: false, drama: null };
            }
        }
    }
    return { notFound: false, drama: null };
}

async function main() {
    ensureDirs();

    const args = process.argv.slice(2);
    const yearArg = args.find((_, i) => args[i - 1] === '--year') || '2026';
    const limitArg = args.find((_, i) => args[i - 1] === '--limit');
    const maxMinutesArg = args.find((_, i) => args[i - 1] === '--max-minutes') || '270'; // Default 4.5 hrs for GHA safe cutoff

    const year = parseInt(yearArg, 10);
    const limit = limitArg ? parseInt(limitArg, 10) : 0;
    const maxMinutes = parseFloat(maxMinutesArg);
    const maxDurationMs = maxMinutes * 60 * 1000;

    console.log('\n🚀 MDL STANDALONE ENRICHMENT ENGINE (GitHub Actions & JSON Edition)');
    console.log('═'.repeat(65));
    console.log(`Target Year:        ${year}`);
    console.log(`Batch Limit:        ${limit > 0 ? limit : 'All Pending'}`);
    console.log(`Safety Cutoff:      ${maxMinutes} minutes (${(maxMinutes / 60).toFixed(1)} hours)`);

    // 1. Load Search Index
    const searchItems = loadSearchIndex(year);
    if (!searchItems || searchItems.length === 0) {
        console.error(`❌ Could not find search index for year ${year}.`);
        console.error(`Please place 'mdl_search_${year}.json' inside 'data/search/'.`);
        process.exit(1);
    }
    console.log(`Total Search Titles: ${searchItems.length}`);

    // 2. Load Existing Enriched Dossiers
    const { filePath, map: enrichedMap } = loadEnrichedArchive(year);
    console.log(`Already Enriched:    ${enrichedMap.size} titles`);

    // 3. Filter Pending Queue
    const pendingItems = searchItems.filter(item => !enrichedMap.has(item.id));
    console.log(`Pending Queue:       ${pendingItems.length} titles`);

    if (pendingItems.length === 0) {
        console.log(`🎉 All ${searchItems.length} titles for ${year} are 100% enriched! Nothing to do.`);
        process.exit(0);
    }

    const queue = limit > 0 ? pendingItems.slice(0, limit) : pendingItems;
    console.log(`Processing Queue:    ${queue.length} titles`);
    console.log('═'.repeat(65) + '\n');

    const scraper = new MdlScraper({
        delayMs: 1000,
        timeoutMs: 25000,
        maxRetries: 3
    });

    const checkpoint = loadCheckpoint();
    const jobStartTime = Date.now();
    let processed = 0;
    let successful = 0;

    // Graceful exit handling
    const onExit = () => {
        console.log('\n💾 Flushing enriched dossiers to disk before exit...');
        flushEnriched(filePath, enrichedMap);
        console.log(`✅ Saved ${enrichedMap.size} dossiers to ${filePath}`);
    };
    process.on('SIGINT', () => { onExit(); process.exit(0); });
    process.on('SIGTERM', () => { onExit(); process.exit(0); });

    for (const item of queue) {
        // Check if runtime has reached the safety cutoff
        const elapsedJobMs = Date.now() - jobStartTime;
        if (elapsedJobMs >= maxDurationMs) {
            console.log(`\n⏰ SAFETY CUTOFF REACHED: Elapsed ${(elapsedJobMs / 60000).toFixed(1)} mins >= limit ${maxMinutes} mins.`);
            console.log('Stopping gracefully so GitHub Actions can commit & push data without runner timeout.');
            break;
        }

        processed++;
        const pct = ((processed / queue.length) * 100).toFixed(1);
        process.stdout.write(`[${processed}/${queue.length} (${pct}%)] `);

        const result = await enrichTitle(scraper, item);

        if (result.drama) {
            enrichedMap.set(result.drama.id, result.drama);
            successful++;

            // Periodically sync to disk every 5 completed titles
            if (successful % 5 === 0) {
                flushEnriched(filePath, enrichedMap);
            }
        }

        // Save progress to checkpoint
        checkpoint[year] = {
            total_titles: searchItems.length,
            enriched: enrichedMap.size,
            pending: searchItems.length - enrichedMap.size,
            last_id: item.id,
            last_title: item.title,
            last_updated: new Date().toISOString()
        };
        saveCheckpoint(checkpoint);

        await randomDelay(1200, 2000);
    }

    // Final flush
    flushEnriched(filePath, enrichedMap);

    const totalElapsedMins = ((Date.now() - jobStartTime) / 60000).toFixed(1);
    console.log('\n' + '═'.repeat(65));
    console.log(`🎉 Batch Finished in ${totalElapsedMins} mins!`);
    console.log(`Successfully Enriched: ${successful}/${processed} titles`);
    console.log(`Total Year ${year} Progress: ${enrichedMap.size}/${searchItems.length} (${((enrichedMap.size / searchItems.length) * 100).toFixed(1)}%)`);
    console.log(`Archive file updated: ${filePath}`);
    console.log('═'.repeat(65) + '\n');
}

main().catch(err => {
    console.error('Fatal Runner Error:', err);
    process.exit(1);
});

