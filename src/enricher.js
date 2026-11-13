/**
 * Standalone JSON-based MDL Deep Detail Enrichment Engine
 * Optimized for GitHub Actions and local execution without native dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { MdlScraper } from './scraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SEARCH_DIR = path.join(DATA_DIR, 'search');
const ENRICHED_DIR = path.join(DATA_DIR, 'enriched');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'checkpoint.json');

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
    }

    return { filePath: enrichedFile, map };
}

function flushEnriched(filePath, map) {
    const arr = Array.from(map.values());
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8');
}

function syncToGit(year, enrichedCount, totalCount) {
    if (process.env.GITHUB_ACTIONS) {
        try {
            console.log(`\n💾 Auto-sync: committing ${enrichedCount}/${totalCount} titles to GitHub...`);
            execSync('git config user.name "github-actions[bot]"', { stdio: 'ignore' });
            execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { stdio: 'ignore' });
            execSync('git add data/', { stdio: 'ignore' });
            execSync(`git commit -m "Auto-enrich: sync ${enrichedCount}/${totalCount} titles for ${year} [skip ci]"`, { stdio: 'ignore' });
            execSync('git pull --rebase origin main', { stdio: 'ignore' });
            execSync('git push origin HEAD:main', { stdio: 'ignore' });
            console.log(`✅ Progress safely committed & pushed to GitHub!\n`);
        } catch {
            // Quietly ignore if no changes or transient network sync issue
        }
    }
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

    // 3. Filter Pending Queue (Resilient: match by ID number/string and Slug)
    const enrichedSlugs = new Set();
    const enrichedIds = new Set();
    for (const d of enrichedMap.values()) {
        if (d.slug) enrichedSlugs.add(String(d.slug).toLowerCase());
        if (d.id) {
            enrichedIds.add(Number(d.id));
            enrichedIds.add(String(d.id));
        }
    }

    const pendingItems = searchItems.filter(item => {
        const idMatches = enrichedIds.has(Number(item.id)) || enrichedIds.has(String(item.id));
        const slugMatches = item.slug && enrichedSlugs.has(String(item.slug).toLowerCase());
        return !idMatches && !slugMatches;
    });
    console.log(`Pending Queue:       ${pendingItems.length} titles`);

    if (pendingItems.length === 0) {
        console.log(`🎉 All ${searchItems.length} titles for ${year} are 100% enriched! Nothing to do.`);
        if (process.env.GITHUB_OUTPUT) {
            try {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_pending=false\nremaining=0\n`);
            } catch {}
        }
        process.exit(0);
    }

    const queue = limit > 0 ? pendingItems.slice(0, limit) : pendingItems;
    console.log(`Processing Queue:    ${queue.length} titles in this run`);
    console.log(`Starting with:       "${queue[0].title}" (ID: ${queue[0].id})`);
    console.log('═'.repeat(65) + '\n');

    const scraper = new MdlScraper({
        delayMs: 1000,
        timeoutMs: 25000,
        maxRetries: 3
    });

    const checkpoint = loadCheckpoint();
    const jobStartTime = Date.now();
    const initialEnriched = enrichedMap.size;
    let processed = 0;
    let successful = 0;

    // Graceful exit handling
    const onExit = () => {
        console.log('\n💾 Flushing enriched dossiers to disk before exit...');
        flushEnriched(filePath, enrichedMap);
        saveCheckpoint(checkpoint);
        syncToGit(year, enrichedMap.size, searchItems.length);
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
        const currentTotal = initialEnriched + successful + 1;
        const totalPct = ((currentTotal / searchItems.length) * 100).toFixed(1);

        process.stdout.write(`[${currentTotal}/${searchItems.length} (${totalPct}%)] (Batch: ${processed}/${queue.length}) `);

        const result = await enrichTitle(scraper, item);

        if (result.drama) {
            enrichedMap.set(result.drama.id, result.drama);
            successful++;

            // Periodically sync to disk every 5 completed titles
            if (successful % 5 === 0) {
                flushEnriched(filePath, enrichedMap);
            }

            // Periodically commit and push to GitHub every 20 completed titles!
            if (successful % 20 === 0) {
                flushEnriched(filePath, enrichedMap);
                saveCheckpoint(checkpoint);
                syncToGit(year, enrichedMap.size, searchItems.length);
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

    // Final flush and push
    flushEnriched(filePath, enrichedMap);
    saveCheckpoint(checkpoint);
    syncToGit(year, enrichedMap.size, searchItems.length);

    const remainingTitles = Math.max(0, searchItems.length - enrichedMap.size);
    const hasPendingRemaining = remainingTitles > 0;

    if (process.env.GITHUB_OUTPUT) {
        try {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_pending=${hasPendingRemaining}\nremaining=${remainingTitles}\n`);
        } catch {}
    }

    const totalElapsedMins = ((Date.now() - jobStartTime) / 60000).toFixed(1);
    console.log('\n' + '═'.repeat(65));
    console.log(`🎉 Batch Finished in ${totalElapsedMins} mins!`);
    console.log(`Successfully Enriched in this run: ${successful}/${processed} titles`);
    console.log(`Total Year ${year} Progress: ${enrichedMap.size}/${searchItems.length} (${((enrichedMap.size / searchItems.length) * 100).toFixed(1)}%)`);
    console.log(`Remaining Pending: ${remainingTitles} titles`);
    console.log(`Archive file updated: ${filePath}`);
    console.log('═'.repeat(65) + '\n');
}

main().catch(err => {
    console.error('Fatal Runner Error:', err);
    process.exit(1);
});
