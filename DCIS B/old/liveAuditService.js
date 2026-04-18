import { chromium } from 'playwright';
import { query } from '../db/pool.js';
import { logger } from '../config/logger.js';

const INTERACTION_TIMEOUT = 5000;

// ── Interaction tests ─────────────────────────────────────────────────────────

async function testButtonInteractions(page) {
  const results = [];
  // Find all visible clickable buttons and primary CTAs
  const buttons = await page.$$('button, [role="button"], input[type="submit"], a.btn, .cta');

  for (const btn of buttons.slice(0, 5)) { // test up to 5 buttons
    try {
      const text = await btn.innerText().catch(() => '');
      const isVisible = await btn.isVisible();
      if (!isVisible || !text.trim()) continue;

      await btn.click({ timeout: INTERACTION_TIMEOUT, force: false });
      await page.waitForTimeout(800);

      const currentUrl = page.url();
      const status = page.url().includes('404') || page.url().includes('error') ? 'error' : 'ok';

      results.push({
        element: 'button',
        text: text.trim().slice(0, 80),
        clicked: true,
        result_url: currentUrl,
        status,
      });

      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch (err) {
      results.push({
        element: 'button',
        text: '',
        clicked: false,
        error: err.message.slice(0, 100),
        status: 'failed',
      });
    }
  }
  return results;
}

async function captureConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push({ type: 'console_error', text: msg.text().slice(0, 200) });
    }
  });
  page.on('pageerror', err => {
    errors.push({ type: 'page_error', text: err.message.slice(0, 200) });
  });
  return errors; // populated via event listeners during page interaction
}

// ── Main auditor ──────────────────────────────────────────────────────────────

export async function auditLiveApp(auditRunId, url) {
  logger.info('Starting live app audit', { auditRunId, url });

  let browser;
  const startTime = Date.now();
  const consoleErrors = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (compatible; DevAuditBot/1.0)',
    });

    const page = await context.newPage();

    // Capture console errors via event listeners
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push({ type: 'console_error', text: msg.text().slice(0, 200) });
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push({ type: 'page_error', text: err.message.slice(0, 200) });
    });

    // Navigate to URL
    let httpStatus = null;
    let isReachable = false;

    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 20000,
    }).catch(() => null);

    if (response) {
      httpStatus = response.status();
      isReachable = httpStatus < 400;
    }

    const loadTime = Date.now() - startTime;
    const pageTitle = await page.title().catch(() => '');

    // Take screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' }).catch(() => null);
    // In production: upload screenshotBuffer to S3 and return URL
    const screenshotUrl = screenshotBuffer ? `[screenshot captured: ${screenshotBuffer.length} bytes]` : null;

    // Run interaction tests
    const interactions = isReachable ? await testButtonInteractions(page) : [];

    const functional = isReachable &&
      interactions.every(i => i.status !== 'error') &&
      consoleErrors.length === 0;

    const result = {
      url,
      is_reachable: isReachable,
      screenshot_url: screenshotUrl,
      page_title: pageTitle,
      load_time_ms: loadTime,
      http_status: httpStatus,
      interactions,
      console_errors: consoleErrors,
      functional,
    };

    await query(
      `INSERT INTO live_audits
        (audit_run_id, url, is_reachable, screenshot_url, page_title, load_time_ms,
         http_status, interactions, console_errors, functional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        auditRunId, url, isReachable, screenshotUrl, pageTitle, loadTime,
        httpStatus,
        JSON.stringify(interactions),
        JSON.stringify(consoleErrors),
        functional,
      ]
    );

    logger.info('Live audit complete', { auditRunId, isReachable, functional, loadTime });
    return result;

  } catch (err) {
    logger.error('Live audit failed', { auditRunId, url, error: err.message });
    const result = {
      url, is_reachable: false, functional: false,
      error: err.message, load_time_ms: Date.now() - startTime,
      interactions: [], console_errors: consoleErrors,
    };
    await query(
      `INSERT INTO live_audits (audit_run_id, url, is_reachable, functional, console_errors)
       VALUES ($1,$2,$3,$4,$5)`,
      [auditRunId, url, false, false, JSON.stringify(consoleErrors)]
    );
    return result;
  } finally {
    if (browser) await browser.close();
  }
}
