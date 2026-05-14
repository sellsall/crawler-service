/**
 * Competitor Headless Crawler Service
 * ─────────────────────────────────────
 * Exposes a local HTTP API (port 3001) for the PHP app to call as a LAST RESORT
 * when normal HTTP crawling is blocked (Cloudflare, etc.).
 *
 * A persistent Chromium instance is reused across requests to reduce startup overhead.
 * Each request gets a fresh browser context (cookies/cache isolated) and is cleaned up after.
 *
 * PHP calls: POST http://104.154.171.86:3001/crawl  { "url": "https://..." }
 * Auth:      X-Crawler-Secret header must match CRAWLER_SERVICE_SECRET in config/config.php
 */

'use strict';

const express = require('express');
const { chromium } = require('playwright');

const app  = express();
const PORT   = process.env.CRAWLER_PORT   || 3001;
const HOST   = '0.0.0.0';   // listen on all interfaces (VM's public IP is firewalled at GCP level)
const SECRET = process.env.CRAWLER_SECRET || 'saddara_crawler_2025'; // Must match config/config.php

app.use(express.json({ limit: '1mb' }));

// ── Browser singleton ────────────────────────────────────────────────────────
let browser = null;
let launchPromise = null;

async function getBrowser() {
    if (browser && browser.isConnected()) return browser;

    if (!launchPromise) {
        launchPromise = chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
            ],
        }).then(b => {
            browser = b;
            launchPromise = null;
            console.log('[crawler] Chromium launched');
            browser.on('disconnected', () => {
                browser = null;
                console.log('[crawler] Chromium disconnected – will relaunch on next request');
            });
            return b;
        });
    }

    return launchPromise;
}

// ── Stealth init script (remove bot signals) ─────────────────────────────────
const STEALTH_SCRIPT = `
    // Hide navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Fake Chrome runtime
    window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
        get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        ]
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['ar-SA', 'ar', 'en-US', 'en'] });
    // Fake screen resolution
    Object.defineProperty(screen, 'availWidth',  { get: () => 1366 });
    Object.defineProperty(screen, 'availHeight', { get: () => 768 });
`;

// ── Health check ─────────────────────────────────────────────────────────────
// ── Secret validation middleware ────────────────────────────────────────────
function requireSecret(req, res, next) {
    const incoming = req.headers['x-crawler-secret'] || '';
    if (SECRET && incoming !== SECRET) {
        console.warn(`[crawler] Unauthorized request from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/health', async (_req, res) => {
    const ready = !!(browser && browser.isConnected());
    res.json({ status: 'ok', browser_ready: ready, pid: process.pid });
});

// ── Shared helper: load one page inside an existing context ──────────────────
async function loadPage(context, url, timeout) {
    const page = await context.newPage();
    try {
        // Block heavy resources to speed up loading
        await page.route('**/*', route => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'other'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        const statusCode = response?.status() ?? 0;

        // Cloudflare JS challenge handling
        const isChallenge = await page.evaluate(() => {
            const t = document.title.toLowerCase();
            return t.includes('just a moment') || t.includes('checking your') ||
                   t.includes('cloudflare') ||
                   !!document.querySelector('#cf-wrapper, .cf-browser-verification');
        });

        if (isChallenge) {
            console.log(`[crawler] CF challenge for ${url} – waiting 10s`);
            await page.waitForTimeout(10000);
            try {
                await page.waitForFunction(
                    () => !document.title.toLowerCase().includes('just a moment'),
                    { timeout: 12000 }
                );
            } catch (_) {}
        }

        // Wait for Vue/Nuxt/React hydration
        try {
            await page.waitForLoadState('networkidle', { timeout: 8000 });
        } catch (_) {
            await page.waitForTimeout(3500);
        }

        const html     = await page.content();
        const title    = await page.title();
        const finalUrl = page.url();

        return { html, title, statusCode, finalUrl };
    } finally {
        try { await page.close(); } catch (_) {}
    }
}

// ── Main crawl endpoint ───────────────────────────────────────────────────────
app.post('/crawl', requireSecret, async (req, res) => {
    const { url, timeout = 20000, product_urls = [] } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url is required' });
    }

    let context = null;
    const start = Date.now();

    try {
        const b = await getBrowser();

        // Single context for ALL pages – CF cookies from homepage are reused for products
        context = await b.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale:    'ar-SA',
            viewport:  { width: 1366, height: 768 },
            extraHTTPHeaders: {
                'Accept-Language':         'ar-SA,ar;q=0.9,en-US,en;q=0.8',
                'Accept':                  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Cache-Control':           'no-cache',
                'Pragma':                  'no-cache',
                'Upgrade-Insecure-Requests': '1',
            },
            ignoreHTTPSErrors: true,
        });
        await context.addInitScript(STEALTH_SCRIPT);

        // ── Load homepage (may solve Cloudflare challenge) ────────
        const home = await loadPage(context, url, timeout);
        console.log(`[crawler] homepage ${url} → ${home.statusCode} in ${Date.now() - start}ms`);

        // ── Load product pages in SAME context (inherits CF cookies) ──
        const productPages = [];
        const validProductUrls = Array.isArray(product_urls) ? product_urls.filter(Boolean) : [];

        for (const pUrl of validProductUrls.slice(0, 3)) {
            const pStart = Date.now();
            try {
                // Product pages: shorter timeout, CF already solved
                const pResult = await loadPage(context, pUrl, Math.min(timeout, 20000));
                const pHtml   = pResult.html;
                productPages.push({
                    url:         pUrl,
                    html:        (pHtml && pHtml.length > 500) ? pHtml : null,
                    status_code: pResult.statusCode,
                    elapsed_ms:  Date.now() - pStart,
                });
                console.log(`[crawler] product ${pUrl} → ${pResult.statusCode} in ${Date.now() - pStart}ms`);
            } catch (err) {
                console.warn(`[crawler] product page failed ${pUrl}: ${err.message}`);
                productPages.push({ url: pUrl, html: null, error: err.message });
            }
        }

        await context.close();
        context = null;

        return res.json({
            html:          home.html,
            title:         home.title,
            status_code:   home.statusCode,
            final_url:     home.finalUrl,
            elapsed_ms:    Date.now() - start,
            strategy:      'headless',
            product_pages: productPages,
        });

    } catch (err) {
        console.error(`[crawler] Error for ${url}:`, err.message);
        if (context) { try { await context.close(); } catch (_) {} }
        return res.status(500).json({ error: err.message, strategy: 'headless_failed' });
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'ALL interfaces' : HOST;
    console.log(`[crawler] Service listening on ${displayHost}:${PORT}`);
    console.log(`[crawler] Secret protection: ${SECRET ? 'enabled' : 'DISABLED – set CRAWLER_SECRET env var!'}`);
    // Pre-warm browser on startup
    getBrowser().catch(err => console.error('[crawler] Pre-warm failed:', err.message));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
    console.log('[crawler] Shutting down...');
    if (browser) {
        try { await browser.close(); } catch (_) {}
    }
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
