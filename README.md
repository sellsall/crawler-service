# Competitor Headless Crawler Service

Fallback service using a real Chromium browser to crawl Cloudflare-protected stores.
**Only activated when normal crawling returns empty data.**

Runs on the **Google Cloud VM** (`104.154.171.86`) on port `3001`.

---

## One-time Setup on the VM

```bash
# 1. Copy crawler-service/ folder to the VM, then:
cd crawler-service
npm install
npm run install-browser        # downloads Chromium (~130 MB) – one time only

# 2. (Optional) Set a custom secret via env var:
export CRAWLER_SECRET=saddara_crawler_2025   # must match config/config.php
```

## Run (production – PM2)

```bash
npm install -g pm2
pm2 start server.js --name crawler-service
pm2 save
pm2 startup    # auto-start on VM reboot
```

## GCP Firewall Rule (required)

Open port **3001** only to your app server IP (not the public internet):

```
gcloud compute firewall-rules create allow-crawler \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:3001 \
  --source-ranges=<YOUR_APP_SERVER_IP>/32 \
  --target-tags=crawler-vm
```

> ⚠️ **Never open port 3001 to `0.0.0.0/0`** – the secret key is an extra layer, but GCP firewall is the primary protection.

---

## PHP Configuration (`config/config.php`)

```php
define('CRAWLER_SERVICE_URL',    'http://104.154.171.86:3001');
define('CRAWLER_SERVICE_SECRET', 'saddara_crawler_2025');
```

---

## API

### `GET /health`
No auth required. Returns browser status.

### `POST /crawl`
Requires header: `X-Crawler-Secret: saddara_crawler_2025`

```json
{ "url": "https://store.example.com", "timeout": 20000 }
```
Returns:
```json
{
  "html": "<html>...</html>",
  "title": "Store Name",
  "status_code": 200,
  "elapsed_ms": 4200,
  "strategy": "headless"
}
```

---

## Cost Control
The PHP app calls this service **only when all 5 normal strategies fail**:
- Direct (Googlebot UA) → Wayback Machine → Bing Cache → Origin bypass → Salla API
- AND result has: no description + no products + no categories (= Cloudflare block page)

Most stores are crawled without ever reaching this service.
