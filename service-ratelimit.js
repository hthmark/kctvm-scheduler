'use strict';
/**
 * Rate limiter and circuit breaker
 * Prevents SMS loops and runaway messaging
 * All limits are per unique phone number or per unique issue
 */

const sentAlerts = new Set();   // tracks "issue keys" we already alerted owner about
const smsCounters = new Map();  // phone -> { minute: count, hour: count, lastReset: ts }

const LIMITS = {
  PER_NUMBER_PER_HOUR: 15,    // max outbound texts to any single customer number per hour
  PER_NUMBER_PER_MINUTE: 3,   // max outbound texts to any single number per minute
};

function getCounters(phone) {
  const now = Date.now();
  let c = smsCounters.get(phone);
  if (!c) {
    c = { minute: 0, hour: 0, minuteStart: now, hourStart: now };
    smsCounters.set(phone, c);
    return c;
  }
  // Reset minute counter
  if (now - c.minuteStart > 60 * 1000) {
    c.minute = 0;
    c.minuteStart = now;
  }
  // Reset hour counter
  if (now - c.hourStart > 60 * 60 * 1000) {
    c.hour = 0;
    c.hourStart = now;
  }
  return c;
}

/**
 * Check if we can send to this number.
 * Returns { allowed: bool, reason: string }
 */
function canSendSMS(to) {
  const phone = to.startsWith('+') ? to : '+1' + to.replace(/\D/g, '');
  const c = getCounters(phone);

  if (c.minute >= LIMITS.PER_NUMBER_PER_MINUTE) {
    console.error('[RateLimit] BLOCKED ' + phone + ' — ' + c.minute + ' texts in last minute');
    return { allowed: false, reason: 'per_minute' };
  }
  if (c.hour >= LIMITS.PER_NUMBER_PER_HOUR) {
    console.error('[RateLimit] BLOCKED ' + phone + ' — ' + c.hour + ' texts in last hour');
    return { allowed: false, reason: 'per_hour' };
  }
  return { allowed: true };
}

/**
 * Record a sent SMS for rate limiting
 */
function recordSMS(to) {
  const phone = to.startsWith('+') ? to : '+1' + to.replace(/\D/g, '');
  const c = getCounters(phone);
  c.minute++;
  c.hour++;
}

/**
 * Check if we should send an owner alert for this specific issue.
 * issueKey should be unique per issue — e.g. "concierge_error:+19135551234"
 * or "manual_needed:+19135551234" or "payout:job_abc123"
 * Returns true if we should send, false if already sent for this issue.
 */
function shouldAlertOwner(issueKey) {
  if (sentAlerts.has(issueKey)) {
    console.log('[RateLimit] Owner alert suppressed — already sent for: ' + issueKey);
    return false;
  }
  sentAlerts.add(issueKey);
  // Auto-expire after 24 hours so the same issue can alert again the next day
  setTimeout(function() { sentAlerts.delete(issueKey); }, 24 * 60 * 60 * 1000);
  return true;
}

/**
 * Clear a specific issue key (e.g. once resolved)
 */
function clearAlert(issueKey) {
  sentAlerts.delete(issueKey);
}

module.exports = { canSendSMS, recordSMS, shouldAlertOwner, clearAlert };
