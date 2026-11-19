/**
 * Next Target Year Resolver
 * Determines whether the current year has pending titles,
 * or identifies the next target year with pending titles to enrich
 * based on direction: 'desc' (descending) or 'asc' (ascending).
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
const CHECKPOINTS_DIR = path.join(DATA_DIR, 'checkpoints');
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

export function resolveNextTargetYear(currentYear, direction = 'desc') {
    let checkpoint = {};
    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        } catch {}
    }
    if (fs.existsSync(CHECKPOINTS_DIR)) {
        try {
            const cpFiles = fs.readdirSync(CHECKPOINTS_DIR).filter(f => /^checkpoint_\d{4}\.json$/.test(f));
            for (const f of cpFiles) {
                const yearData = JSON.parse(fs.readFileSync(path.join(CHECKPOINTS_DIR, f), 'utf8'));
                Object.assign(checkpoint, yearData);
            }
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

    const isYearComplete = (y) => {
        const searchPath = path.join(SEARCH_DIR, `mdl_search_${y}.json`);
        const total = countItems(searchPath);
        if (total === 0) return true;

        if (checkpoint[y] && checkpoint[y].pending === 0 && checkpoint[y].enriched >= total) {
            return true;
        }

        const enriched = getEnrichedCountForYear(y);
        return enriched >= total;
    };

    // 1. First check if currentYear still has pending items
    if (!isYearComplete(curr)) {
        return String(curr);
    }

    // 2. Current year is complete! Search based on direction
    let candidateYears = [];
    if (direction === 'asc') {
        // Ascending: search years > curr, sorted lowest to highest (e.g. 1990 -> 1991 -> 1992 ...)
        candidateYears = searchYears.filter(y => y > curr).sort((a, b) => a - b);
    } else {
        // Descending: search years < curr, sorted highest to lowest (e.g. 2024 -> 2023 -> 2022 ...)
        candidateYears = searchYears.filter(y => y < curr).sort((a, b) => b - a);
    }

    for (const y of candidateYears) {
        if (!isYearComplete(y)) {
            return String(y);
        }
    }

    return 'NONE';
}

// CLI Execution
const args = process.argv.slice(2);
const currentArg = args.find((_, i) => args[i - 1] === '--current') || '2024';
const directionArg = args.find((_, i) => args[i - 1] === '--direction') || 'desc';
const nextYear = resolveNextTargetYear(currentArg, directionArg);
console.log(nextYear);
