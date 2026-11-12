/**
 * Cloudflare Connectivity & IP Probe
 * Tests whether this machine / GitHub Actions runner IP is accepted by MyDramaList's Cloudflare CDN.
 */

import { HttpClient } from './client.js';

async function runProbe() {
    console.log('\n🔎 PROBING CLOUDFLARE CONNECTIVITY TO MYDRAMALIST:');
    console.log('═'.repeat(60));

    const client = new HttpClient({ timeoutMs: 15000, maxRetries: 1 });
    const testSlug = '712367-crash-landing-on-you';
    const testUrl = `https://mydramalist.com/${testSlug}`;

    console.log(`Target: ${testUrl}`);
    console.log(`Platform: ${process.platform} (${process.arch})`);
    console.log(`Node.js: ${process.version}`);
    console.log(`Sending curl request with browser headers...\n`);

    const start = Date.now();
    try {
        const html = await client.getHtml(testSlug);
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);

        if (!html) {
            console.error(`❌ PROBE FAILED: Received null (404 Not Found or empty body) in ${elapsed}s.`);
            process.exit(1);
        }

        // Check for Cloudflare Turnstile / Captcha / Attention Required markers
        if (html.includes('cf-browser-verification') || html.includes('Attention Required! | Cloudflare') || html.includes('challenge-running')) {
            console.error(`🛑 CLOUDFLARE BLOCK DETECTED! (${elapsed}s)`);
            console.error('The server returned a Cloudflare Bot/CAPTCHA challenge.');
            console.error('This runner IP is currently flagged by Cloudflare CDN.');
            process.exit(1);
        }

        if (html.includes('<h1 class="film-title">') && html.includes('Crash Landing on You')) {
            console.log(`✅ PROBE PASSED! (${elapsed}s)`);
            console.log('Successfully retrieved full HTML page without any Cloudflare challenge.');
            console.log('The runner IP is CLEAN and ready for scraping!\n');
            process.exit(0);
        }

        console.log(`⚠️ PROBE WARNING: Retrieved HTML (${html.length} bytes) in ${elapsed}s, but title marker differed.`);
        process.exit(0);
    } catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        console.error(`❌ PROBE FAILED in ${elapsed}s: ${err.message}`);
        console.error('\nPossible causes:');
        console.error('1. No outbound internet connection.');
        console.error('2. Cloudflare returned an HTTP 403 or dropped connection for this data center IP.');
        process.exit(1);
    }
}

runProbe();

