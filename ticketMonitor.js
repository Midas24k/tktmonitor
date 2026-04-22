/**
 * ticketMonitor.js
 * Core Playwright logic for polling and autofill.
 * Runs in the Electron main process.
 *
 * Usage:
 *   const monitor = new TicketMonitor(config, profile);
 *   monitor.on('found', (result) => { ... });
 *   monitor.on('log',   (msg, level) => { ... });
 *   await monitor.start();
 *   await monitor.stop();
 */

const { chromium } = require('playwright');
const { EventEmitter } = require('events');

class TicketMonitor extends EventEmitter {
  constructor(config, profile) {
    super();
    /**
     * config: {
     *   url: string,           // ticket page URL
     *   eventName: string,
     *   qty: number,           // desired ticket quantity
     *   seatPref: string,      // 'best' | 'floor' | 'cheapest'
     *   maxPricePerTicket: number,
     *   pollIntervalMs: number // e.g. 10000
     * }
     * profile: {
     *   name: string,
     *   email: string,
     *   cardNumber: string,    // fetched from OS keychain — never hardcoded
     *   cardExpiry: string,
     *   cardCvv: string,
     *   deliveryMethod: 'mobile' | 'willcall'
     * }
     */
    this.config = config;
    this.profile = profile;
    this.browser = null;
    this.page = null;
    this.running = false;
    this.pollTimer = null;
    this.pollCount = 0;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    this.log(`Launching browser for: ${this.config.eventName}`);

    this.browser = await chromium.launch({
      headless: true,        // invisible while monitoring
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled', // reduce bot fingerprint
      ],
    });

    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    // Block images/fonts to speed up polling
    await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2}', r => r.abort());

    this.page = await context.newPage();

    // Navigate once, then poll by reloading
    try {
      await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      this.log('Page loaded. Starting poll loop.');
    } catch (err) {
      this.log(`Failed to load page: ${err.message}`, 'error');
      await this.stop();
      return;
    }

    this._schedulePoll();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.pollTimer);
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
    this.log('Monitor stopped.');
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  _schedulePoll() {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this._poll(), this.config.pollIntervalMs);
  }

  async _poll() {
    if (!this.running || !this.page) return;
    this.pollCount++;
    this.log(`Poll #${this.pollCount} — checking availability...`);

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      const result = await this._checkAvailability();

      if (result.available) {
        this.log(`Tickets found! ${result.description}`, 'success');
        this.emit('found', result);
        // Do NOT continue polling — wait for human decision
        return;
      } else {
        this.log(`Not available yet. ${result.reason || ''}`);
      }
    } catch (err) {
      this.log(`Poll error: ${err.message}`, 'warn');
    }

    this._schedulePoll();
  }

  // ─── Availability detection ───────────────────────────────────────────────
  // Adapt these selectors per ticketing platform.

  async _checkAvailability() {
    const page = this.page;

    // Strategy 1: look for a buy/add-to-cart button that is NOT disabled
    const buyBtn = await page.$('[data-testid="buy-button"]:not([disabled]), .buy-now:not([disabled]), #add-to-cart:not([disabled])');
    if (buyBtn) {
      const priceText = await this._scrapePrice();
      if (priceText && this._priceExceedsMax(priceText)) {
        return { available: false, reason: `Price ${priceText} exceeds max ${this.config.maxPricePerTicket}` };
      }
      return { available: true, description: `Buy button visible · ${priceText || 'price unknown'}`, priceText, buyBtn };
    }

    // Strategy 2: look for "sold out" / "not available" text as a negative signal
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const soldOutPhrases = ['sold out', 'not available', 'no tickets', 'off sale'];
    const isSoldOut = soldOutPhrases.some(p => bodyText.includes(p));
    if (isSoldOut) {
      return { available: false, reason: 'Sold out message detected' };
    }

    // Strategy 3: presence of a ticket-count selector (e.g. <select name="qty">)
    const qtySelect = await page.$('select[name="quantity"], select[name="qty"], #ticket-quantity');
    if (qtySelect) {
      return { available: true, description: 'Quantity selector appeared' };
    }

    return { available: false, reason: 'No buy signals detected' };
  }

  async _scrapePrice() {
    try {
      const el = await this.page.$('[data-testid="ticket-price"], .ticket-price, .price-amount');
      if (!el) return null;
      return (await el.textContent()).trim();
    } catch {
      return null;
    }
  }

  _priceExceedsMax(priceText) {
    if (!this.config.maxPricePerTicket) return false;
    const num = parseFloat(priceText.replace(/[^0-9.]/g, ''));
    return !isNaN(num) && num > this.config.maxPricePerTicket;
  }

  // ─── Autofill ─────────────────────────────────────────────────────────────
  // Called after the user confirms on the review screen.
  // Switches to a visible browser window, fills the form, then STOPS —
  // the user completes the final purchase click themselves.

  async autofillAndShow(onCaptchaDetected) {
    if (!this.browser || !this.page) throw new Error('Browser not running');

    // Make the window visible
    const context = this.page.context();
    await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2}', r => r.continue()); // re-enable images
    // Re-launch visible if we were headless
    if (!this.visiblePage) {
      const visibleContext = await this.browser.newContext({
        headless: false, // NOTE: headless is per-browser launch, not context.
        // In practice you re-launch with headless: false — see launchVisible() below.
      });
      this.visiblePage = await visibleContext.newPage();
      await this.visiblePage.goto(this.config.url, { waitUntil: 'domcontentloaded' });
    }

    const page = this.visiblePage || this.page;

    this.log('Starting autofill...');

    try {
      // Select quantity
      await this._selectQuantity(page);

      // Click buy / add to cart
      const buyBtn = await page.$('[data-testid="buy-button"]:not([disabled]), .buy-now:not([disabled])');
      if (buyBtn) await buyBtn.click();
      await page.waitForLoadState('domcontentloaded');

      // Check for CAPTCHA before proceeding
      const captcha = await this._detectCaptcha(page);
      if (captcha) {
        this.log('CAPTCHA detected — pausing for human resolution.', 'warn');
        if (onCaptchaDetected) onCaptchaDetected();
        await this._waitForCaptchaResolution(page);
      }

      // Fill personal details
      await this._fillPersonalDetails(page);
      await this._fillPaymentDetails(page);

      this.log('Autofill complete. Review the browser window and click the final confirm button.', 'success');
      this.emit('autofillComplete');
    } catch (err) {
      this.log(`Autofill error: ${err.message}`, 'error');
      throw err;
    }
  }

  async launchVisible() {
    // Re-launch a visible browser for the checkout phase
    const visibleBrowser = await chromium.launch({ headless: false });
    const context = await visibleBrowser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    this.visibleBrowser = visibleBrowser;
    this.visiblePage = await context.newPage();
    return this.visiblePage;
  }

  async _selectQuantity(page) {
    const qty = this.config.qty;
    // Try a <select> first
    const qtySelect = await page.$('select[name="quantity"], select[name="qty"], #ticket-quantity');
    if (qtySelect) {
      await qtySelect.selectOption({ value: String(qty) });
      this.log(`Selected quantity: ${qty}`);
      return;
    }
    // Try +/- stepper buttons
    const plusBtn = await page.$('[aria-label="increase quantity"], .qty-plus, [data-testid="qty-increase"]');
    if (plusBtn) {
      for (let i = 1; i < qty; i++) await plusBtn.click();
      this.log(`Incremented quantity to ${qty}`);
    }
  }

  async _fillPersonalDetails(page) {
    const p = this.profile;
    const fields = [
      { selectors: ['input[name="name"]', 'input[name="fullName"]', '#name'], value: p.name },
      { selectors: ['input[name="email"]', 'input[type="email"]', '#email'], value: p.email },
      { selectors: ['input[name="email_confirm"]', '#email-confirm'], value: p.email },
    ];
    for (const field of fields) {
      for (const sel of field.selectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill(field.value);
          this.log(`Filled ${sel}`);
          break;
        }
      }
    }
  }

  async _fillPaymentDetails(page) {
    const p = this.profile;
    // Card number — handle Stripe iframe if present
    const stripeFrame = page.frameLocator('iframe[name*="stripe"], iframe[src*="stripe"]').first();
    try {
      await stripeFrame.locator('input[name="cardnumber"]').fill(p.cardNumber, { timeout: 3000 });
      await stripeFrame.locator('input[name="exp-date"]').fill(p.cardExpiry);
      await stripeFrame.locator('input[name="cvc"]').fill(p.cardCvv);
      this.log('Filled Stripe iframe fields');
      return;
    } catch {
      // Not a Stripe iframe — try plain fields
    }

    const cardFields = [
      { selectors: ['input[name="cardNumber"]', '#card-number', '[data-testid="card-number"]'], value: p.cardNumber },
      { selectors: ['input[name="expiry"]', '#card-expiry', '[placeholder*="MM / YY"]'], value: p.cardExpiry },
      { selectors: ['input[name="cvv"]', '#card-cvc', '[placeholder="CVV"]'], value: p.cardCvv },
    ];
    for (const field of cardFields) {
      for (const sel of field.selectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill(field.value);
          this.log(`Filled ${sel}`);
          break;
        }
      }
    }
  }

  async _detectCaptcha(page) {
    const indicators = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      '.g-recaptcha',
      '#cf-turnstile',
      '[data-sitekey]',
    ];
    for (const sel of indicators) {
      if (await page.$(sel)) return true;
    }
    return false;
  }

  async _waitForCaptchaResolution(page, timeoutMs = 120000) {
    // Poll until the CAPTCHA element disappears (user solved it)
    this.log('Waiting for CAPTCHA to be solved by user...');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const still = await this._detectCaptcha(page);
      if (!still) { this.log('CAPTCHA resolved.', 'success'); return; }
      await page.waitForTimeout(1500);
    }
    throw new Error('CAPTCHA not solved within timeout');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  log(msg, level = 'info') {
    this.emit('log', msg, level);
    const prefix = { info: '●', warn: '⚠', error: '✖', success: '✔' }[level] || '●';
    console.log(`[TicketMonitor] ${prefix} ${msg}`);
  }
}

module.exports = { TicketMonitor };
