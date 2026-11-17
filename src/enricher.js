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

// GitHub hard limits files to 100 MB (104,857,600 bytes).
// Safe rollover threshold: 80 MB (83,886,080 bytes) ensures formatted JSON will always stay strictly under 90-95 MB.
const MAX_PART_SIZE_BYTES = 80 * 1024 * 1024;

class EnrichedPart {
    constructor(filePath, partNum, items = [], isLegacySingle = false) {
        this.filePath = filePath;
        this.partNum = partNum;
        this.items = items;
        this.dirty = false;
        this.isSealed = false;
        this.size = 0;
        this.isLegacySingle = isLegacySingle;
    }
}

class PartitionManager {
    constructor(year, enrichedDir, maxPartSizeBytes = MAX_PART_SIZE_BYTES) {
        this.year = year;
        this.enrichedDir = enrichedDir;
        this.maxPartSizeBytes = maxPartSizeBytes;
        this.parts = [];
        this.allMap = new Map();
        this.activePart = null;
        this._init();
    }

    _init() {
        if (!fs.existsSync(this.enrichedDir)) {
            fs.mkdirSync(this.enrichedDir, { recursive: true });
        }

        // Auto-split any pre-existing oversized files (legacy single or existing parts)
        const initialScan = fs.readdirSync(this.enrichedDir);
        for (const f of initialScan) {
            if (f === `mdl_enriched_${this.year}.json` || new RegExp(`^mdl_enriched_${this.year}_part\\d+\\.json$`).test(f)) {
                this._splitOversizedFileIfAny(path.join(this.enrichedDir, f));
            }
        }

        const files = fs.readdirSync(this.enrichedDir);
        const singleRegex = new RegExp(`^mdl_enriched_${this.year}\\.json$`);
        const partRegex = new RegExp(`^mdl_enriched_${this.year}_part(\\d+)\\.json$`);

        const partFiles = [];
        for (const file of files) {
            const singleMatch = file.match(singleRegex);
            const partMatch = file.match(partRegex);
            if (singleMatch) {
                partFiles.push({ file, partNum: 1, isLegacySingle: true });
            } else if (partMatch) {
                partFiles.push({ file, partNum: parseInt(partMatch[1], 10), isLegacySingle: false });
            }
        }

        // Deduplicate in case both mdl_enriched_2025.json and mdl_enriched_2025_part1.json exist
        const hasPart1 = partFiles.some(p => !p.isLegacySingle && p.partNum === 1);
        const validPartFiles = partFiles.filter(p => !(p.isLegacySingle && hasPart1));

        validPartFiles.sort((a, b) => a.partNum - b.partNum);

        if (validPartFiles.length === 0) {
            // No existing files, start with single format
            const initialPath = path.join(this.enrichedDir, `mdl_enriched_${this.year}.json`);
            const p = new EnrichedPart(initialPath, 1, [], true);
            this.parts.push(p);
            this.activePart = p;
            return;
        }

        for (const pf of validPartFiles) {
            const fullPath = path.join(this.enrichedDir, pf.file);
            let items = [];
            try {
                items = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                if (!Array.isArray(items)) items = [];
            } catch (err) {
                console.warn(`Warning reading ${fullPath}: ${err.message}`);
            }

            const stats = fs.statSync(fullPath);
            const part = new EnrichedPart(fullPath, pf.partNum, items, pf.isLegacySingle);
            part.size = stats.size;

            for (const item of items) {
                if (item && item.id) {
                    this.allMap.set(item.id, item);
                }
            }

            this.parts.push(part);
        }

        // Determine active part
        const lastPart = this.parts[this.parts.length - 1];
        if (lastPart.size >= this.maxPartSizeBytes) {
            lastPart.isSealed = true;
            if (lastPart.isLegacySingle) {
                const renamedPath = path.join(this.enrichedDir, `mdl_enriched_${this.year}_part1.json`);
                fs.renameSync(lastPart.filePath, renamedPath);
                lastPart.filePath = renamedPath;
                lastPart.isLegacySingle = false;
                console.log(`📦 Sealed Part 1 as ${path.basename(renamedPath)}`);
            }

            const nextPartNum = lastPart.partNum + 1;
            const nextPath = path.join(this.enrichedDir, `mdl_enriched_${this.year}_part${nextPartNum}.json`);
            const newPart = new EnrichedPart(nextPath, nextPartNum, [], false);
            fs.writeFileSync(nextPath, '[\n]\n', 'utf8');
            newPart.size = fs.statSync(nextPath).size;
            this.parts.push(newPart);
            this.activePart = newPart;
            console.log(`✨ Created new archive partition: ${path.basename(nextPath)}`);
        } else {
            this.activePart = lastPart;
        }
    }

    _splitOversizedFileIfAny(filePath) {
        if (!fs.existsSync(filePath)) return;
        const stats = fs.statSync(filePath);
        if (stats.size < this.maxPartSizeBytes) return;

        console.log(`⚠️ File ${path.basename(filePath)} (${(stats.size / 1024 / 1024).toFixed(1)} MB) exceeds ${(this.maxPartSizeBytes / 1024 / 1024).toFixed(0)} MB limit. Auto-splitting into safe parts...`);
        let items = [];
        try {
            items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error(`Failed to parse oversized file ${filePath}: ${e.message}`);
            return;
        }
        if (!Array.isArray(items) || items.length === 0) return;

        const safeTargetBytes = this.maxPartSizeBytes * 0.85;
        const numParts = Math.max(2, Math.ceil(stats.size / safeTargetBytes));
        const itemsPerPart = Math.ceil(items.length / numParts);

        console.log(`  Dividing ${items.length} titles into ${numParts} parts (~${itemsPerPart} titles per part)...`);

        for (let i = 0; i < numParts; i++) {
            const chunk = items.slice(i * itemsPerPart, (i + 1) * itemsPerPart);
            if (chunk.length === 0) continue;
            const partNum = i + 1;
            const outPath = path.join(this.enrichedDir, `mdl_enriched_${this.year}_part${partNum}.json`);
            fs.writeFileSync(outPath, JSON.stringify(chunk, null, 2), 'utf8');
            const partSizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
            console.log(`  -> Wrote ${path.basename(outPath)} (${chunk.length} titles, ${partSizeMB} MB)`);
        }

        const legacyPath = path.join(this.enrichedDir, `mdl_enriched_${this.year}.json`);
        if (filePath === legacyPath && fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
            console.log(`  -> Removed original oversized file: ${path.basename(legacyPath)}`);
        }
    }

    addItem(item) {
        if (!item || !item.id) return;
        this.allMap.set(item.id, item);
        this.activePart.items.push(item);
        this.activePart.dirty = true;
    }

    flush() {
        if (!this.activePart || !this.activePart.dirty) return;

        const content = JSON.stringify(this.activePart.items, null, 2);
        const byteLength = Buffer.byteLength(content, 'utf8');
        fs.writeFileSync(this.activePart.filePath, content, 'utf8');
        this.activePart.size = byteLength;
        this.activePart.dirty = false;

        // Check rollover if active part size reached threshold
        if (this.activePart.size >= this.maxPartSizeBytes) {
            console.log(`\n📦 Partition reached ${(this.activePart.size / 1024 / 1024).toFixed(1)} MB (threshold: ${(this.maxPartSizeBytes / 1024 / 1024).toFixed(0)} MB).`);
            this.activePart.isSealed = true;

            // If it was legacy single filename, rename to _part1.json
            if (this.activePart.isLegacySingle) {
                const renamedPath = path.join(this.enrichedDir, `mdl_enriched_${this.year}_part1.json`);
                fs.renameSync(this.activePart.filePath, renamedPath);
                this.activePart.filePath = renamedPath;
                this.activePart.isLegacySingle = false;
                console.log(`  Renamed to ${path.basename(renamedPath)}`);
            }

            const nextPartNum = this.activePart.partNum + 1;
            const nextFileName = `mdl_enriched_${this.year}_part${nextPartNum}.json`;
            const nextPath = path.join(this.enrichedDir, nextFileName);
            const newPart = new EnrichedPart(nextPath, nextPartNum, [], false);
            fs.writeFileSync(nextPath, '[\n]\n', 'utf8');
            newPart.size = fs.statSync(nextPath).size;
            this.parts.push(newPart);
            this.activePart = newPart;
            console.log(`✨ Created new archive partition: ${nextFileName} (all subsequent titles will be written here)\n`);
        }
    }

    get totalCount() {
        return this.allMap.size;
    }

    get activeFilePath() {
        return this.activePart ? this.activePart.filePath : '';
    }

    getAllItems() {
        return Array.from(this.allMap.values());
    }
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
                // Verified 404 Not Found on MDL - record tombstone so queue is not stuck in infinite retry
                console.log(`[Enricher] ⚠️ Genuine 404 Not Found on MDL: "${item.title}" (ID: ${item.id}). Recorded tombstone.`);
                const tombstone = {
                    id: item.id,
                    slug: item.slug || String(item.id),
                    title: item.title,
                    year: item.year || null,
                    notFound: true,
                    scraped_at: new Date().toISOString()
                };
                return { notFound: true, drama: tombstone };
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
    const maxPartMbArg = args.find((_, i) => args[i - 1] === '--max-part-mb') || '95'; // Safe threshold (under GitHub's 100MB limit)

    const year = parseInt(yearArg, 10);
    const limit = limitArg ? parseInt(limitArg, 10) : 0;
    const maxMinutes = parseFloat(maxMinutesArg);
    const maxDurationMs = maxMinutes * 60 * 1000;
    const maxPartSizeBytes = parseFloat(maxPartMbArg) * 1024 * 1024;

    console.log('\n🚀 MDL STANDALONE ENRICHMENT ENGINE (GitHub Actions & JSON Edition)');
    console.log('═'.repeat(65));
    console.log(`Target Year:        ${year}`);
    console.log(`Batch Limit:        ${limit > 0 ? limit : 'All Pending'}`);
    console.log(`Safety Cutoff:      ${maxMinutes} minutes (${(maxMinutes / 60).toFixed(1)} hours)`);
    console.log(`Part Size Cap:      ${maxPartMbArg} MB (auto-splits before 100 MB GitHub limit)`);

    // 1. Load Search Index
    const searchItems = loadSearchIndex(year);
    if (!searchItems || searchItems.length === 0) {
        console.error(`❌ Could not find search index for year ${year}.`);
        console.error(`Please place 'mdl_search_${year}.json' inside 'data/search/'.`);
        process.exit(1);
    }
    console.log(`Total Search Titles: ${searchItems.length}`);

    // 2. Load Existing Enriched Dossiers via PartitionManager
    const archive = new PartitionManager(year, ENRICHED_DIR, maxPartSizeBytes);
    console.log(`Already Enriched:    ${archive.totalCount} titles`);
    console.log(`Partitions:          ${archive.parts.length} file(s) (Active: ${path.basename(archive.activeFilePath)})`);

    // 3. Filter Pending Queue (Resilient: match by ID number/string and Slug)
    const enrichedSlugs = new Set();
    const enrichedIds = new Set();
    for (const d of archive.getAllItems()) {
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
    const initialEnriched = archive.totalCount;
    let processed = 0;
    let successful = 0;

    // Graceful exit handling
    const onExit = () => {
        console.log('\n💾 Flushing enriched dossiers to disk before exit...');
        archive.flush();
        saveCheckpoint(checkpoint);
        syncToGit(year, archive.totalCount, searchItems.length);
        console.log(`✅ Saved ${archive.totalCount} dossiers across ${archive.parts.length} partition(s)`);
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
            archive.addItem(result.drama);
            successful++;

            // Periodically sync to disk every 5 completed titles
            if (successful % 5 === 0) {
                archive.flush();
            }

            // Periodically commit and push to GitHub every 20 completed titles!
            if (successful % 20 === 0) {
                archive.flush();
                saveCheckpoint(checkpoint);
                syncToGit(year, archive.totalCount, searchItems.length);
            }
        }

        // Save progress to checkpoint
        checkpoint[year] = {
            total_titles: searchItems.length,
            enriched: archive.totalCount,
            pending: searchItems.length - archive.totalCount,
            parts_count: archive.parts.length,
            active_part: path.basename(archive.activeFilePath),
            last_id: item.id,
            last_title: item.title,
            last_updated: new Date().toISOString()
        };
        saveCheckpoint(checkpoint);

        await randomDelay(1200, 2000);
    }

    // Final flush and push
    archive.flush();
    saveCheckpoint(checkpoint);
    syncToGit(year, archive.totalCount, searchItems.length);

    const remainingTitles = Math.max(0, searchItems.length - archive.totalCount);
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
    console.log(`Total Year ${year} Progress: ${archive.totalCount}/${searchItems.length} (${((archive.totalCount / searchItems.length) * 100).toFixed(1)}%)`);
    console.log(`Remaining Pending: ${remainingTitles} titles`);
    console.log(`Partitions Count:  ${archive.parts.length} file(s)`);
    console.log(`Active Partition:  ${archive.activeFilePath}`);
    console.log('═'.repeat(65) + '\n');
}

main().catch(err => {
    console.error('Fatal Runner Error:', err);
    process.exit(1);
});
