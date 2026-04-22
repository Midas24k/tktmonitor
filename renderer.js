/**
 * renderer.js
 * Wires your HTML UI to the window.ticketBot API exposed by preload.js.
 * Drop this into your renderer bundle (React, vanilla JS, etc.)
 *
 * This is a vanilla JS example — adapt to your framework of choice.
 */

// ─── State ────────────────────────────────────────────────────────────────

let isMonitoring = false;
let cleanupListeners = [];

// ─── DOM helpers ──────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function log(msg, level = 'info') {
  const el = $('activity-log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function showScreen(id) {
  ['screen-monitor', 'screen-confirm', 'screen-success'].forEach(s => {
    const el = $(s);
    if (el) el.style.display = s === id ? '' : 'none';
  });
}

// ─── Load saved profile on startup ────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  const profile = await window.ticketBot.loadProfile();
  if (profile) {
    if ($('u-name'))  $('u-name').value  = profile.name  || '';
    if ($('u-email')) $('u-email').value = profile.email || '';
    if ($('u-card') && profile.cardLast4) $('u-card').value = `•••• ${profile.cardLast4}`;
  }

  // Register event listeners from main process
  cleanupListeners.push(
    window.ticketBot.onLog(({ msg, level }) => log(msg, level))
  );

  cleanupListeners.push(
    window.ticketBot.onFound((result) => {
      log(`Tickets found: ${result.description}`, 'success');
      showConfirmScreen(result);
    })
  );

  cleanupListeners.push(
    window.ticketBot.onAutofillComplete(() => {
      log('Autofill done — complete the purchase in the browser window.', 'success');
      showScreen('screen-success');
    })
  );

  cleanupListeners.push(
    window.ticketBot.onCaptchaDetected(() => {
      log('CAPTCHA detected — please solve it in the browser window.', 'warn');
      showCaptchaBanner();
    })
  );
});

// ─── Start monitoring ──────────────────────────────────────────────────────

async function startMonitor() {
  const config = {
    url:                  $('ticket-url')?.value?.trim(),
    eventName:            $('event-name')?.value?.trim(),
    qty:                  parseInt($('qty')?.value) || 2,
    seatPref:             $('seat-pref')?.value || 'best',
    maxPricePerTicket:    parseFloat($('max-price')?.value?.replace(/[^0-9.]/g, '')) || null,
    pollIntervalMs:       (parseInt($('poll-interval')?.value) || 10) * 1000,
  };

  if (!config.url || !config.eventName) {
    log('Please fill in the event name and URL.', 'error');
    return;
  }

  // Save profile first
  await saveProfile();

  const result = await window.ticketBot.startMonitor(config);
  if (result.ok) {
    isMonitoring = true;
    $('btn-start')?.setAttribute('disabled', true);
    $('btn-stop')?.removeAttribute('disabled');
    $('status-dot')?.classList.add('active');
    log(`Monitoring started: ${config.eventName} every ${config.pollIntervalMs / 1000}s`);
  } else {
    log(`Failed to start: ${result.error}`, 'error');
  }
}

// ─── Stop monitoring ───────────────────────────────────────────────────────

async function stopMonitor() {
  await window.ticketBot.stopMonitor();
  isMonitoring = false;
  $('btn-start')?.removeAttribute('disabled');
  $('btn-stop')?.setAttribute('disabled', true);
  $('status-dot')?.classList.remove('active');
  log('Monitoring stopped.');
}

// ─── Confirm screen ────────────────────────────────────────────────────────

function showConfirmScreen(result) {
  // Populate summary fields
  if ($('found-seats'))  $('found-seats').textContent  = result.description || '—';
  if ($('found-price'))  $('found-price').textContent  = result.priceText   || '—';
  if ($('c-name'))       $('c-name').value  = $('u-name')?.value  || '';
  if ($('c-email'))      $('c-email').value = $('u-email')?.value || '';
  showScreen('screen-confirm');
}

async function confirmOrder() {
  log('Starting autofill — opening browser window...');
  const result = await window.ticketBot.confirmOrder();
  if (!result.ok) {
    log(`Autofill failed: ${result.error}`, 'error');
  }
}

async function cancelOrder() {
  log('Skipping these tickets. Resuming monitor...', 'warn');
  showScreen('screen-monitor');
  await window.ticketBot.resumeMonitor();
}

function showCaptchaBanner() {
  const banner = $('captcha-banner');
  if (banner) banner.style.display = '';
}

// ─── Save profile ──────────────────────────────────────────────────────────
// NOTE: card number should be entered in a dedicated settings screen
// and stored via profile:save — never read it back to the UI.

async function saveProfile() {
  const profile = {
    name:           $('u-name')?.value?.trim()  || '',
    email:          $('u-email')?.value?.trim() || '',
    // Card details are only saved from the Settings screen — not from the
    // monitor config panel — so we only overwrite them if explicitly provided.
    deliveryMethod: $('u-delivery')?.value || 'mobile',
  };
  await window.ticketBot.saveProfile(profile);
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  cleanupListeners.forEach(fn => fn?.());
});

// Expose to inline HTML onclick handlers
window.startMonitor   = startMonitor;
window.stopMonitor    = stopMonitor;
window.confirmOrder   = confirmOrder;
window.cancelOrder    = cancelOrder;
