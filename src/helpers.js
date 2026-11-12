/**
 * Data parsing and cleanup helpers
 */

export function cleanText(str) {
    if (!str) return '';
    return str.replace(/\s+/g, ' ').trim();
}

export function parseInteger(str) {
    if (!str) return null;
    const digits = String(str).replace(/[^\d]/g, '');
    if (!digits) return null;
    const val = parseInt(digits, 10);
    return isNaN(val) ? null : val;
}

export function parseFloatSafe(str) {
    if (!str) return null;
    const match = String(str).match(/\d+(?:\.\d+)?/);
    if (!match) return null;
    const val = parseFloat(match[0]);
    return isNaN(val) ? null : val;
}

export function parseYear(str) {
    if (!str) return null;
    const match = String(str).match(/\b(19\d{2}|20\d{2})\b/);
    return match ? parseInt(match[1], 10) : null;
}

export function durationToMinutes(str) {
    if (!str) return null;
    let total = 0;
    const hrMatch = String(str).match(/(\d+)\s*hr/i);
    const minMatch = String(str).match(/(\d+)\s*min/i);
    if (hrMatch) total += parseInt(hrMatch[1], 10) * 60;
    if (minMatch) total += parseInt(minMatch[1], 10);
    return total > 0 ? total : null;
}

export function toFullResolutionImage(url) {
    if (!url) return '';
    const clean = url.split('?')[0].trim();
    // Upgrades thumbnails (_3s, _3c, _3m) to full original asset (_3f)
    return clean.replace(/_(\d+)[a-z]?(\.[a-zA-Z0-9]+)$/i, '_$1f$2');
}

export function extractSlug(href) {
    if (!href) return '';
    try {
        if (href.startsWith('http://') || href.startsWith('https://')) {
            const u = new URL(href);
            return u.pathname.replace(/^\/+/, '').replace(/\/$/, '');
        }
    } catch {
        // ignore
    }
    return href.replace(/^\/+/, '').split('?')[0].replace(/\/$/, '');
}

export function extractIdFromSlug(slug) {
    if (!slug) return null;
    const match = String(slug).match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

export function parseDateString(dateStr) {
    if (!dateStr) return null;
    try {
        const d = new Date(dateStr.trim());
        if (!isNaN(d.getTime())) {
            return d.toISOString().split('T')[0];
        }
    } catch {
        // ignore
    }
    return null;
}

export function parseAiredDates(airedStr) {
    if (!airedStr) return { start: null, end: null };
    const parts = airedStr.split('-');
    const start = parseDateString(parts[0]);
    const end = parts.length > 1 ? parseDateString(parts[1]) : start;
    return { start, end };
}

