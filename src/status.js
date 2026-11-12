/**
 * Prints current enrichment progress across all years.
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
const LOCAL_MDL_DB = path.resolve(__dirname, '../../MDL/MDL_DB');

function getYears() {
    const years = new Set();
    const scanDir = (dir) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(f => {
            const m = f.match(/mdl_(?:search|enriched)_(\d{4})\.json/);
            if (m) years.add(parseInt(m[1], 10));
        });
    };

    scanDir(SEARCH_DIR);
    scanDir(ENRICHED_DIR);
    scanDir(LOCAL_MDL_DB);

    return Array.from(years).sort((a, b) => b - a);
}

function countItems(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    try {
        const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(arr) ? arr.length : 0;
    } catch {
        return 0;
    }
}

function runStatus() {
    console.log('\n📊 MDL DATASET ENRICHMENT STATUS:');
    console.log('═'.repeat(65));

    const years = getYears();
    if (years.length === 0) {
        console.log('No search or enriched JSON files found.');
        return;
    }

    const rows = [];
    let grandTotalSearch = 0;
    let grandTotalEnriched = 0;

    for (const year of years) {
        const searchPath = fs.existsSync(path.join(SEARCH_DIR, `mdl_search_${year}.json`))
            ? path.join(SEARCH_DIR, `mdl_search_${year}.json`)
            : path.join(LOCAL_MDL_DB, `mdl_search_${year}.json`);

        const enrichedPath = fs.existsSync(path.join(ENRICHED_DIR, `mdl_enriched_${year}.json`))
            ? path.join(ENRICHED_DIR, `mdl_enriched_${year}.json`)
            : path.join(LOCAL_MDL_DB, `mdl_enriched_${year}.json`);

        const total = countItems(searchPath);
        const enriched = countItems(enrichedPath);
        const pending = Math.max(0, total - enriched);
        const pct = total > 0 ? ((enriched / total) * 100).toFixed(1) + '%' : '0%';

        grandTotalSearch += total;
        grandTotalEnriched += enriched;

        rows.push({
            year,
            total_titles: total,
            enriched,
            pending,
            progress: pct
        });
    }

    console.table(rows);
    console.log(`Grand Total Indexed:  ${grandTotalSearch}`);
    console.log(`Grand Total Enriched: ${grandTotalEnriched} (${grandTotalSearch > 0 ? ((grandTotalEnriched / grandTotalSearch) * 100).toFixed(1) : 0}%)`);
    console.log(`Grand Total Pending:  ${grandTotalSearch - grandTotalEnriched}\n`);
}

runStatus();

