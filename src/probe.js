/**
 * Cloudflare Connectivity & IP Probe
 * Diagnoses whether this runner IP is accepted by MyDramaList's Cloudflare CDN.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

async function runProbe() {
    console.log('\n🔎 DETAILED CLOUDFLARE CONNECTIVITY PROBE:');
    console.log('═'.repeat(65));
    console.log(`Platform: ${process.platform} (${process.arch})`);
    console.log(`Node.js:  ${process.version}`);

    // 1. Get Runner Public IP & Location
    try {
        const { stdout: ip } = await execFileAsync(CURL_BIN, ['-s', 'https://api.ipify.org']);
        console.log(`Runner Public IP: ${ip.trim()}`);
    } catch {
        console.log('Runner Public IP: Could not resolve');
    }

    const testUrl = 'https://mydramalist.com/712367-crash-landing-on-you';
    console.log(`Target URL:       ${testUrl}\n`);

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`--- Attempt ${attempt}/3 ---`);
        const start = Date.now();

        try {
            const { stdout } = await execFileAsync(CURL_BIN, [
                '-sL',
                '--compressed',
                '--max-time', '20',
                '-w', '\n__HTTP_STATUS__:%{http_code}',
                '-A', userAgent,
                '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                '-H', 'Accept-Language: en-US,en;q=0.9',
                '-H', 'Referer: https://mydramalist.com/',
                testUrl
            ]);

            const elapsed = ((Date.now() - start) / 1000).toFixed(2);
            const statusIdx = stdout.lastIndexOf('__HTTP_STATUS__:');
            let statusCode = 0;
            let body = stdout;

            if (statusIdx !== -1) {
                body = stdout.slice(0, statusIdx);
                statusCode = parseInt(stdout.slice(statusIdx + '__HTTP_STATUS__:'.length).trim(), 10) || 0;
            }

            console.log(`HTTP Status: ${statusCode} (took ${elapsed}s, response size: ${body.length} bytes)`);

            // Check if Cloudflare challenged
            if (body.includes('Attention Required! | Cloudflare') || body.includes('cf-browser-verification') || body.includes('challenge-running')) {
                console.error('🛑 Cloudflare CAPTCHA / Bot Challenge detected!');
                console.log('Snippet:', body.slice(0, 300).replace(/\s+/g, ' '));
                process.exit(1);
            }

            if (statusCode === 200 && body.includes('Crash Landing on You')) {
                console.log('\n🎉 PROBE SUCCESS! MyDramaList returned 200 OK without challenges.');
                console.log('Cloudflare is ALLOWING this runner IP!\n');
                process.exit(0);
            }

            console.log('Response Snippet:', body.slice(0, 350).replace(/\s+/g, ' '));

            if (attempt < 3) {
                console.log(`Waiting 3 seconds before retry...\n`);
                await new Promise(r => setTimeout(r, 3000));
            }
        } catch (err) {
            console.error(`Curl error: ${err.message}`);
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    console.error('\n❌ All 3 probe attempts failed. Cloudflare is blocking requests from this Azure data center IP.');
    process.exit(1);
}

runProbe();
