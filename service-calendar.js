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

  // Get current Chicago time
  const nowChicagoStr = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const nowChicago = new Date(nowChicagoStr);

  const todayChicago = new Date(nowChicago);
  todayChicago.setHours(0, 0, 0, 0);

  let hour = 9;
  let minute = 0;

  const timeMatch = input.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    if (timeMatch[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (timeMatch[3].toLowerCase() === 'am' && hour === 12) hour = 0;
  } else if (input.includes('noon')) {
    hour = 12;
  } else if (input.includes('morning')) {
    hour = 9;
  } else if (input.includes('afternoon')) {
    hour = 13;
  } else if (input.includes('evening')) {
    hour = 17;
  } else if (input.includes('night')) {
    hour = 18;
  }

  const time24Match = input.match(/(\d{2}):(\d{2})/);
  if (time24Match && !timeMatch) {
    hour = parseInt(time24Match[1]);
    minute = parseInt(time24Match[2]);
  }

  let targetChicago = new Date(todayChicago);

  if (input.includes('today')) {
    // already today
  } else if (input.includes('tomorrow')) {
    targetChicago.setDate(todayChicago.getDate() + 1);
  } else {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    let foundDay = -1;
    for (let i = 0; i < days.length; i++) {
      if (input.includes(days[i])) { foundDay = i; break; }
    }

    if (foundDay !== -1) {
      const currentDay = todayChicago.getDay();
      let daysUntil = foundDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      if (input.includes('next')) daysUntil += 7;
      targetChicago.setDate(todayChicago.getDate() + daysUntil);
    } else {
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      let foundMonth = -1;
      for (let i = 0; i < months.length; i++) {
        if (input.includes(months[i])) { foundMonth = i; break; }
      }
      if (foundMonth !== -1) {
        const dayMatch = input.match(/(\d{1,2})(st|nd|rd|th)?/);
        const dayNum = dayMatch ? parseInt(dayMatch[1]) : 1;
        targetChicago = new Date(todayChicago.getFullYear(), foundMonth, dayNum, 0, 0, 0, 0);
        if (targetChicago < todayChicago) targetChicago.setFullYear(todayChicago.getFullYear() + 1);
      } else {
        console.warn(`[Calendar] Could not parse time: "${str}"`);
        return null;
      }
    }
  }

  // Set hour/minute in Chicago local time
  targetChicago.setHours(hour, minute, 0, 0);

  // Convert Chicago local to UTC properly using offset
  const chicagoOffset = getChicagoUTCOffsetMinutes(targetChicago);
  const utcTime = new Date(targetChicago.getTime() + chicagoOffset * 60 * 1000);

  if (utcTime <= new Date()) {
    console.warn(`[Calendar] Parsed date is in the past: ${utcTime} for input "${str}"`);
    return null;
  }

  console.log(`[Calendar] Parsed "${str}" → Chicago local: ${targetChicago.toLocaleString('en-US', {timeZone:'America/Chicago'})} → UTC: ${utcTime.toISOString()}`);
  return utcTime;
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

module.exports = { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse };
