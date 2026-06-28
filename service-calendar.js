const { google } = require('googleapis');

function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * Parse natural language time strings into a Date object
 * All times interpreted as America/Chicago (Kansas City)
 */
function attemptDateParse(str) {
  if (!str) return null;

  const direct = new Date(str);
  if (!isNaN(direct.getTime()) && direct.getFullYear() > 2020) return direct;

  const input = str.toLowerCase().trim();

  // Extract hour/minute
  let hour = 9, minute = 0;
  const timeMatch = input.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    if (timeMatch[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (timeMatch[3].toLowerCase() === 'am' && hour === 12) hour = 0;
  } else if (input.includes('noon')) { hour = 12; }
  else if (input.includes('morning')) { hour = 9; }
  else if (input.includes('afternoon')) { hour = 13; }
  else if (input.includes('evening')) { hour = 17; }

  // Get today's date in Chicago
  const nowChicago = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, d, y] = nowChicago.split('/');
  const today = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));

  let target = new Date(today);

  // Handle "Sun, 6/14, 8:00 AM" format from concierge slot labels
  var slotMatch = input.match(/(\d{1,2})\/(\d{1,2}),?\s*(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
  if (slotMatch) {
    var month = parseInt(slotMatch[1]) - 1;
    var day = parseInt(slotMatch[2]);
    var slotHour = parseInt(slotMatch[3]);
    var slotMin = slotMatch[4] ? parseInt(slotMatch[4]) : 0;
    var slotAmpm = slotMatch[5].toLowerCase();
    if (slotAmpm === 'pm' && slotHour !== 12) slotHour += 12;
    if (slotAmpm === 'am' && slotHour === 12) slotHour = 0;
    var slotYear = new Date().getFullYear();
    var slotDate = new Date(slotYear, month, day, slotHour, slotMin, 0, 0);
    var slotOffset = new Date(slotDate.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    var slotUtc = new Date(slotDate.getTime() + (slotDate - slotOffset));
    if (slotUtc > new Date()) {
      console.log('[Calendar] Parsed slot label "' + str + '" → ' + slotUtc.toISOString());
      return slotUtc;
    }
  }

  if (input.includes('tomorrow')) {
    target.setDate(target.getDate() + 1);
  } else if (!input.includes('today')) {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    let foundDay = -1;
    for (let i = 0; i < days.length; i++) {
      if (input.includes(days[i])) { foundDay = i; break; }
    }
    if (foundDay !== -1) {
      let daysUntil = foundDay - today.getDay();
      if (daysUntil <= 0) daysUntil += 7;
      if (input.includes('next')) daysUntil += 7;
      target.setDate(today.getDate() + daysUntil);
    } else {
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      let foundMonth = -1;
      for (let i = 0; i < months.length; i++) {
        if (input.includes(months[i])) { foundMonth = i; break; }
      }
      if (foundMonth !== -1) {
        const dayMatch = input.match(/(\d{1,2})(st|nd|rd|th)?/);
        const dayNum = dayMatch ? parseInt(dayMatch[1]) : 1;
        target = new Date(today.getFullYear(), foundMonth, dayNum);
        if (target < today) target.setFullYear(today.getFullYear() + 1);
      } else {
        // No day context at all — bare time like "2pm" or "11am"
        // If a time match was found, resolve to today or tomorrow based on 4-hour threshold
        if (timeMatch) {
          // target is already today; check if today at this time is ≥4h from now
          const testNow = new Date(target.getFullYear(), target.getMonth(), target.getDate(), hour, minute);
          const nowMs = Date.now();
          const chicagoOffsetMs = (() => {
            const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' });
            const p = fmt.formatToParts(testNow).find(x => x.type === 'timeZoneName');
            const m = p ? p.value.match(/GMT([+-]\d+)/) : null;
            return (m ? parseInt(m[1]) : -5) * 60 * 60 * 1000;
          })();
          const todayAtTimeUTC = testNow.getTime() - chicagoOffsetMs;
          if (todayAtTimeUTC - nowMs < 4 * 60 * 60 * 1000) {
            // Too soon or past — use tomorrow
            target.setDate(target.getDate() + 1);
            console.log('[Calendar] Bare time "' + str + '" is <4h away today — using tomorrow');
          } else {
            console.log('[Calendar] Bare time "' + str + '" is ≥4h away — using today');
          }
        } else {
          console.warn('[Calendar] Could not parse: "' + str + '"');
          return null;
        }
      }
    }
  }

  // Build ISO string with Chicago offset (CDT = -05:00, CST = -06:00)
  // Use Intl to get the actual offset for the target date
  const testDate = new Date(target.getFullYear(), target.getMonth(), target.getDate(), hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(testDate);
  const offsetPart = parts.find(p => p.type === 'timeZoneName');
  const offsetStr = offsetPart ? offsetPart.value : 'GMT-5';
  const offsetMatch = offsetStr.match(/GMT([+-]\d+)/);
  const offsetHours = offsetMatch ? parseInt(offsetMatch[1]) : -5;
  const utcDate = new Date(testDate.getTime() - offsetHours * 60 * 60 * 1000);

  if (utcDate <= new Date()) {
    console.warn('[Calendar] Parsed date is in the past for "' + str + '"');
    return null;
  }

  console.log('[Calendar] Parsed "' + str + '" → ' + hour + ':' + String(minute).padStart(2,'0') + ' Chicago → UTC: ' + utcDate.toISOString());
  return utcDate;
}

/**
 * Get Chicago UTC offset in minutes (handles DST automatically)
 * CDT (summer) = UTC-5 = +300 min, CST (winter) = UTC-6 = +360 min
 */
function getChicagoUTCOffsetMinutes(date) {
  const chicagoStr = date.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const chicagoDate = new Date(chicagoStr);
  const utcDate = new Date(utcStr);
  return (utcDate - chicagoDate) / 60000;
}

async function isTimeAvailable(startTime, durationMinutes = 90) {
  const calendar = getCalendarClient();
  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      items: [{ id: process.env.GOOGLE_CALENDAR_ID }],
    },
  });
  const busy = response.data.calendars[process.env.GOOGLE_CALENDAR_ID].busy;
  return busy.length === 0;
}

async function createJobEvent(job, startTime) {
  const calendar = getCalendarClient();
  const endTime = new Date(startTime.getTime() + 90 * 60 * 1000);
  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `TV Mount — ${job.customer_name} (${job.city})`,
      description: `Customer: ${job.customer_name}\nPhone: ${job.customer_phone}\nTVs: ${job.num_tvs}\nTotal: $${job.total_price}\nJob ID: ${job.id}`,
      start: { dateTime: startTime.toISOString(), timeZone: 'America/Chicago' },
      end: { dateTime: endTime.toISOString(), timeZone: 'America/Chicago' },
      colorId: '5',
    },
  });
  console.log(`[Calendar] Event created: ${event.data.id}`);
  return event.data.id;
}

async function confirmJobEvent(eventId, techName) {
  const calendar = getCalendarClient();
  await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId,
    requestBody: { colorId: '2', description: `Tech: ${techName}` },
  });
}

async function deleteJobEvent(eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId });
  console.log(`[Calendar] Event deleted: ${eventId}`);
}

async function findNextAvailableTime(requestedTime) {
  const getChicagoMinutes = (d) => {
    const parts = d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: false });
    const m = parts.match(/(\d+):(\d+)/);
    if (!m) return 720;
    return parseInt(m[1]) * 60 + parseInt(m[2]);
  };

  if (requestedTime) {
    const parsed = attemptDateParse(requestedTime);
    console.log('[Calendar] Requested time: "' + requestedTime + '" parsed to: ' + (parsed ? parsed.toISOString() : 'null'));
    if (parsed && parsed > new Date()) {
      // Business-hours check first — outside 7am–7pm KC means after-hours, not a conflict
      const reqMins = getChicagoMinutes(parsed);
      if (reqMins >= 7 * 60 && reqMins <= 19 * 60) {
        let avail = false;
        try { avail = await isTimeAvailable(parsed); } catch(e) {}
        if (avail) {
          const timeStr = parsed.toLocaleString('en-US', {
            timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
            hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
          });
          return { time: parsed, label: timeStr, raw: parsed.toISOString(), exact: true };
        }
      } else {
        console.log('[Calendar] Requested time ' + parsed.toISOString() + ' is outside business hours (' + reqMins + ' mins) — finding next morning slot');
      }
    }
  }

  const now = new Date();
  // Start at least 4h from now, rounded up to next clean :00 or :30
  let candidate = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const cm = candidate.getMinutes();
  if (cm > 0 && cm <= 30) {
    candidate.setMinutes(30, 0, 0);
  } else if (cm > 30) {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  }

  let safetyCount = 0;
  while (safetyCount++ < 48) {
    const mins = getChicagoMinutes(candidate);
    if (mins >= 8 * 60 && mins <= 19 * 60) break;
    const nextDay = new Date(candidate);
    nextDay.setDate(nextDay.getDate() + (mins > 19 * 60 ? 1 : 0));
    const dateStr = nextDay.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = dateStr.split('/');
    candidate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]), 8, 0, 0, 0);
    const offset = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    candidate = new Date(candidate.getTime() + (candidate - offset));
  }

  for (let i = 0; i < 20; i++) {
    // Skip slots outside 7 AM–7 PM Chicago — advance to next morning if needed
    const slotMins = getChicagoMinutes(candidate);
    if (slotMins < 7 * 60 || slotMins > 19 * 60) {
      const nextDay = new Date(candidate);
      if (slotMins > 19 * 60) nextDay.setDate(nextDay.getDate() + 1);
      const dateStr = nextDay.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
      const parts = dateStr.split('/');
      candidate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]), 8, 0, 0, 0);
      const offset = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      candidate = new Date(candidate.getTime() + (candidate - offset));
      continue;
    }

    try {
      // Check 90-min job window + 30-min buffer after = 120 min total to ensure no back-to-back jobs
      const available = await isTimeAvailable(candidate, 120);
      if (available) {
        const label = candidate.toLocaleString('en-US', {
          timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
        });
        return { time: candidate, label: label, raw: candidate.toISOString(), exact: false };
      }
    } catch (err) {
      console.error('[Calendar] findNextAvailableTime error:', err.message);
      break;
    }
    candidate = new Date(candidate.getTime() + 90 * 60 * 1000);
  }
  return null;
}

module.exports = { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse, findNextAvailableTime };
