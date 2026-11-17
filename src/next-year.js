/**
 * Next Target Year Resolver
 * Determines whether the current year has pending titles,
 * or identifies the next descending year with pending titles to enrich.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SEARCH_DIR = path.join(DATA_DIR, 'search');
const ENRICHED_DIR = path.join(DATA_DIR, 'enriched');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'checkpoint.json');

function countItems(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    try {
        const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(arr) ? arr.length : 0;
    } catch {
        return 0;
    }
}

function getEnrichedCountForYear(year) {
    if (!fs.existsSync(ENRICHED_DIR)) return 0;
    const files = fs.readdirSync(ENRICHED_DIR).filter(f => {
        return f === `mdl_enriched_${year}.json` || new RegExp(`^mdl_enriched_${year}_part\\d+\\.json$`).test(f);
    });
    if (files.length === 0) return 0;

    // Deduplicate legacy single if part1 exists
    const hasPart1 = files.some(f => f === `mdl_enriched_${year}_part1.json`);
    const validFiles = files.filter(f => !(f === `mdl_enriched_${year}.json` && hasPart1));

    let count = 0;
    for (const f of validFiles) {
        count += countItems(path.join(ENRICHED_DIR, f));
    }
    return count;
}

export function resolveNextTargetYear(currentYear) {
    let checkpoint = {};
    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        } catch {}
    }

    if (!fs.existsSync(SEARCH_DIR)) {
        return 'NONE';
    }

    const searchFiles = fs.readdirSync(SEARCH_DIR).filter(f => /^mdl_search_(\d{4})\.json$/.test(f));
    const searchYears = searchFiles
        .map(f => parseInt(f.match(/\d{4}/)[0], 10))
        .sort((a, b) => b - a);

    if (searchYears.length === 0) {
        return 'NONE';
    }

    const curr = parseInt(currentYear, 10) || searchYears[0];

    // 1. First check if currentYear still has pending items
    const currSearchFile = path.join(SEARCH_DIR, `mdl_search_${curr}.json`);
    if (fs.existsSync(currSearchFile)) {
        const total = countItems(currSearchFile);
        const enriched = getEnrichedCountForYear(curr);
        const isCpPending = checkpoint[curr] && checkpoint[curr].pending > 0;
        const isCountPending = total > enriched;

        if (isCpPending || isCountPending) {
            return String(curr);
        }
    }

    // 2. Current year is complete! Search descending from currentYear
    const candidateYears = searchYears.filter(y => y < curr);
    // Also include any remaining search years if descending search finishes:
    searchYears.forEach(y => {
        if (!candidateYears.includes(y) && y !== curr) {
            candidateYears.push(y);
        }
    });

    for (const y of candidateYears) {
        const searchPath = path.join(SEARCH_DIR, `mdl_search_${y}.json`);
        const total = countItems(searchPath);
        if (total === 0) continue;

        // Check checkpoint first
        if (checkpoint[y] && checkpoint[y].pending === 0 && checkpoint[y].enriched >= total) {
            continue; // Confirmed 100% complete
        }

        const enriched = getEnrichedCountForYear(y);
        if (enriched < total) {
            return String(y);
        }
    }

    return 'NONE';
}

// CLI Execution
const args = process.argv.slice(2);
const currentArg = args.find((_, i) => args[i - 1] === '--current') || '2024';
const nextYear = resolveNextTargetYear(currentArg);
console.log(nextYear);
