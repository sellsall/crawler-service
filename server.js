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

const express      = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Register stealth plugin — patches ~20 Cloudflare/bot-detection vectors:
// navigator.webdriver, chrome runtime, plugins, permissions, TLS, canvas, WebGL, etc.
chromium.use(StealthPlugin());

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
        // Try real Google Chrome first (better TLS fingerprint, trusted by Cloudflare).
        // Falls back to Playwright's Chromium if Chrome is not installed.
        const chromePaths = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
        ];
        const fs = require('fs');
        const installedChrome = chromePaths.find(p => fs.existsSync(p));

        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--metrics-recording-only',
                '--no-first-run',
                '--no-zygote',
                '--disable-extensions',
                '--window-size=1366,768',
                '--js-flags=--max-old-space-size=256',
            ],
        };

        if (installedChrome) {
            launchOptions.executablePath = installedChrome;
            console.log('[crawler] Using real Chrome: ' + installedChrome);
        } else {
            launchOptions.channel = undefined; // use Playwright Chromium
            console.log('[crawler] Chrome not found – using Playwright Chromium (run: apt-get install google-chrome-stable)');
        }

        launchPromise = chromium.launch(launchOptions).then(b => {
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

// Stealth plugin handles all webdriver/fingerprint patching automatically.
// No manual init script needed.

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

// ── Helper: load a single page inside an existing context ────────────────────
async function loadPage(context, url, timeout) {
    const page = await context.newPage();
    try {
        await page.route('**/*', route => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'other'].includes(type)) route.abort();
            else route.continue();
        });

        const response   = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        const statusCode = response?.status() ?? 0;

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

        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); }
        catch (_) { await page.waitForTimeout(3500); }

        const html     = await page.content();
        const title    = await page.title();
        const finalUrl = page.url();
        return { html, title, statusCode, finalUrl };
    } finally {
        try { await page.close(); } catch (_) {}
    }
}

// ── Main crawl endpoint ──────────────────────────────────────────────────────
app.post('/crawl', requireSecret, async (req, res) => {
    const { url, timeout = 20000, product_urls = [], max_products = 3 } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url is required' });
    }

    // ── Hard timeout: ALWAYS send a response within 55s no matter what ──────
    // Prevents Chrome from hanging PHP indefinitely.
    const HARD_TIMEOUT_MS = 55000;
    let context    = null;
    let responded  = false;
    const start    = Date.now();

    function safeRespond(statusCode, data) {
        if (responded) return;
        responded = true;
        clearTimeout(hardTimer);
        res.status(statusCode).json(data);
    }

    const hardTimer = setTimeout(() => {
        console.warn(`[crawler] HARD TIMEOUT (${HARD_TIMEOUT_MS}ms) for ${url}`);
        // Respond FIRST before any async cleanup – context.close() can itself hang
        safeRespond(500, { error: `hard_timeout: Chrome did not respond within ${HARD_TIMEOUT_MS/1000}s`, strategy: 'headless_timeout' });
        // Close context in background, do not await
        if (context) { context.close().catch(() => {}); }
    }, HARD_TIMEOUT_MS);

    try {
        const b = await getBrowser();

        // One context for all pages – CF cookies are shared
        context = await b.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale:    'ar-SA',
            viewport:  { width: 1366, height: 768 },
            extraHTTPHeaders: {
                'Accept-Language':           'ar-SA,ar;q=0.9,en-US,en;q=0.8',
                'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Cache-Control':             'no-cache',
                'Pragma':                    'no-cache',
                'Upgrade-Insecure-Requests': '1',
            },
            ignoreHTTPSErrors: true,
        });

        // ── Step 1: Load homepage ──────────────────────────────────────
        const page = await context.newPage();
        await page.route('**/*', route => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'other'].includes(type)) route.abort();
            else route.continue();
        });

        const homeResp   = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        const statusCode = homeResp?.status() ?? 0;

        // Handle Cloudflare JS challenge
        const isChallenge = await page.evaluate(() => {
            const t = document.title.toLowerCase();
            return t.includes('just a moment') || t.includes('checking your') ||
                   t.includes('cloudflare') ||
                   !!document.querySelector('#cf-wrapper, .cf-browser-verification');
        });
        if (isChallenge) {
            console.log(`[crawler] CF challenge for ${url} – waiting 6s`);
            await page.waitForTimeout(6000);
            try {
                await page.waitForFunction(
                    () => !document.title.toLowerCase().includes('just a moment'),
                    { timeout: 8000 }
                );
            } catch (_) {}
        }

        // Wait for SPA to render (with short timeout to avoid blocking)
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); }
        catch (_) { await page.waitForTimeout(2000); }

        const homepageHtml  = await page.content();
        const homepageTitle = await page.title();
        const finalUrl      = page.url();
        const origin        = new URL(finalUrl).origin;

        console.log(`[crawler] homepage ${url} → ${statusCode} (${homepageHtml.length} bytes) in ${Date.now()-start}ms`);

        // ── Step 2: Discover product links (skip if max_products=0) ───────
        let urlsToVisit = [];

        if (max_products > 0) {
        urlsToVisit = Array.isArray(product_urls) ? product_urls.filter(Boolean) : [];

        if (urlsToVisit.length === 0) {
            urlsToVisit = await page.evaluate((storeOrigin) => {
                const seen    = new Set();
                const results = [];
                function isProductUrl(href) {
                    return href.includes('/products/') || href.includes('/product/') ||
                           href.includes('/item/')     || href.includes('/p/')        ||
                           /\/\d{5,}(?:[/?#]|$)/.test(href)  ||
                           /[_-]\d{5,}(?:[/?#]|$)/.test(href);
                }
                for (const a of document.querySelectorAll('a[href]')) {
                    const href = a.href;
                    if (!href || !href.startsWith(storeOrigin)) continue;
                    if (isProductUrl(href) && !seen.has(href)) {
                        seen.add(href);
                        results.push(href);
                        if (results.length >= 6) break;
                    }
                }
                if (results.length === 0) {
                    const cards = document.querySelectorAll('[data-product-id], [data-id]');
                    for (const card of cards) {
                        const a = card.querySelector('a[href]') || (card.tagName === 'A' ? card : null);
                        if (!a) continue;
                        const href = a.href;
                        if (!href || !href.startsWith(storeOrigin)) continue;
                        if (!seen.has(href)) {
                            seen.add(href);
                            results.push(href);
                            if (results.length >= 6) break;
                        }
                    }
                }
                return results;
            }, origin);
            if (urlsToVisit.length > 0) {
                console.log(`[crawler] Auto-discovered ${urlsToVisit.length} product URLs`);
            }
        }
        } // end if (max_products > 0)

        await page.close();

        // ── Step 3: Visit product pages ───────────────────────────────────
        const productPages = [];
        for (const pUrl of urlsToVisit.slice(0, max_products)) {
            const pStart = Date.now();
            try {
                const p = await loadPage(context, pUrl, Math.min(timeout, 22000));
                productPages.push({
                    url:         pUrl,
                    html:        (p.html && p.html.length > 500) ? p.html : null,
                    status_code: p.statusCode,
                    elapsed_ms:  Date.now() - pStart,
                });
                console.log(`[crawler] product ${pUrl} → ${p.statusCode} in ${Date.now()-pStart}ms`);
            } catch (err) {
                console.warn(`[crawler] product page failed ${pUrl}: ${err.message}`);
                productPages.push({ url: pUrl, html: null, error: err.message });
            }
        }

        await context.close();
        context = null;

        safeRespond(200, {
            html:          homepageHtml,
            title:         homepageTitle,
            status_code:   statusCode,
            final_url:     finalUrl,
            elapsed_ms:    Date.now() - start,
            strategy:      'headless',
            product_pages: productPages,
        });

    } catch (err) {
        console.error(`[crawler] Error for ${url}:`, err.message);
        if (context) { try { await context.close(); } catch (_) {} }
        safeRespond(500, { error: err.message, strategy: 'headless_failed' });
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
