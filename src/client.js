import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Cross-platform curl binary name (curl on Linux/macOS, curl.exe on Windows)
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

export class HttpClient {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || 'https://mydramalist.com';
        this.delayMs = options.delayMs ?? 1200;
        this.timeoutMs = options.timeoutMs ?? 25000;
        this.maxRetries = options.maxRetries ?? 3;
        this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        this.lastRequestTime = 0;
    }

    async throttle() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.delayMs) {
            await new Promise(resolve => setTimeout(resolve, this.delayMs - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Executes HTTP GET using system curl (to pass Cloudflare's TLS fingerprint checks)
     * with retry logic and true 404 detection.
     * Returns null ONLY if the resource genuinely returned 404 Not Found.
     * Throws an error on network/timeout/server failure after retries are exhausted.
     */
    async getHtml(pathOrUrl, retries = this.maxRetries) {
        const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}/${pathOrUrl.replace(/^\//, '')}`;
        const timeoutSec = Math.max(5, Math.ceil(this.timeoutMs / 1000));
        let lastError = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            await this.throttle();

            // 1. Try system curl
            try {
                const { stdout } = await execFileAsync(CURL_BIN, [
                    '-sL',
                    '--compressed',
                    '--max-time', String(timeoutSec),
                    '-w', '\n__HTTP_STATUS__:%{http_code}',
                    '-A', this.userAgent,
                    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    '-H', 'Accept-Language: en-US,en;q=0.9',
                    '-H', `Referer: ${this.baseUrl}/`,
                    url
                ], {
                    maxBuffer: 25 * 1024 * 1024,
                    windowsHide: true
                });

                if (stdout) {
                    const statusIdx = stdout.lastIndexOf('__HTTP_STATUS__:');
                    let statusCode = 200;
                    let body = stdout;
                    if (statusIdx !== -1) {
                        body = stdout.slice(0, statusIdx);
                        const statusStr = stdout.slice(statusIdx + '__HTTP_STATUS__:'.length).trim();
                        statusCode = parseInt(statusStr, 10) || 0;
                    }

                    // Genuine 404 Not Found on MDL:
                    // 1. HTTP status 404
                    // 2. HTTP status 500 with blank body (MDL returns empty 500 for missing/deleted drama IDs)
                    // 3. Official MDL 404 page title (<title>Page not found - MyDramaList or <title>404 Not Found - MyDramaList)
                    // NOTE: Do NOT check body.includes('404 Not Found') globally, because dramas can be titled "404 Not Found" (e.g. ID 806916) or reviews can mention "404 Not Found" (e.g. ID 791006)!
                    const is404 = statusCode === 404 || 
                                  (statusCode === 500 && body.trim().length <= 20) ||
                                  /<title>\s*(?:404\s+Not\s+Found|Page\s+not\s+found)\s*-\s*MyDramaList/i.test(body);

                    if (is404) {
                        return null;
                    }

                    // Rate limited (429)
                    if (statusCode === 429) {
                        const waitMs = 3000 * attempt;
                        console.warn(`[MDL Client] Rate limited (429) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    // Cloudflare or Server error (500, 502, 503, 504)
                    if (statusCode >= 500) {
                        const waitMs = 2500 * attempt;
                        console.warn(`[MDL Client] Server error (${statusCode}) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    // Valid response body (HTML or JSON)
                    if (body.length > 200 && (body.includes('<html') || body.includes('<!DOCTYPE') || body.trim().startsWith('{') || body.trim().startsWith('['))) {
                        return body;
                    }
                }
            } catch (curlErr) {
                lastError = curlErr;
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                    continue;
                }
            }

            // 2. Fallback to native fetch if curl attempt failed
            try {
                const res = await fetch(url, {
                    headers: {
                        'User-Agent': this.userAgent,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': `${this.baseUrl}/`
                    },
                    signal: AbortSignal.timeout(this.timeoutMs)
                });

                if (res.status === 404) return null;
                if (res.status === 429) {
                    const retrySec = parseInt(res.headers.get('retry-after') || '3', 10);
                    await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
                    continue;
                }

                if (res.ok) {
                    return await res.text();
                }

                if (res.status >= 500) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                    continue;
                }
            } catch (fetchErr) {
                lastError = fetchErr;
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }

        throw new Error(`[MDL Client] Network/Server failure fetching ${url} after ${retries} attempts: ${lastError?.message || 'Unknown network error'}`);
    }
}

