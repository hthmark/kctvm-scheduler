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
        console.warn('[Calendar] Could not parse: "' + str + '"');
        return null;
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
  if (requestedTime) {
    const parsed = attemptDateParse(requestedTime);
    console.log('[Calendar] Requested time: "' + requestedTime + '" parsed to: ' + (parsed ? parsed.toISOString() : 'null'));
    if (parsed && parsed > new Date()) {
      let avail = false;
      try { avail = await isTimeAvailable(parsed); } catch(e) {}
      if (avail) {
        const timeStr = parsed.toLocaleString('en-US', {
          timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
        });
        return { time: parsed, label: timeStr, raw: parsed.toISOString(), exact: true };
      }
    }
  }

  const now = new Date();
  let candidate = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const minutes = candidate.getMinutes();
  if (minutes < 30) {
    candidate.setMinutes(30, 0, 0);
  } else {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  }

  const getChicagoHour = (d) => {
    const str = d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: true });
    const match = str.match(/(\d+):?(\d*)\s*(AM|PM)/i);
    if (!match) return 12;
    let h = parseInt(match[1]);
    const ampm = match[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h;
  };

  let safetyCount = 0;
  while (safetyCount++ < 48) {
    const hour = getChicagoHour(candidate);
    if (hour >= 8 && hour < 19) break;
    const nextDay = new Date(candidate);
    nextDay.setDate(nextDay.getDate() + (hour >= 19 ? 1 : 0));
    const dateStr = nextDay.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = dateStr.split('/');
    candidate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]), 8, 0, 0, 0);
    const offset = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    candidate = new Date(candidate.getTime() + (candidate - offset));
  }

  for (let i = 0; i < 20; i++) {
    try {
      const available = await isTimeAvailable(candidate);
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
    candidate = new Date(candidate.getTime() + 30 * 60 * 1000);
  }
  return null;
}

module.exports = { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse, findNextAvailableTime };
