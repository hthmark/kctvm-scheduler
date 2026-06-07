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
 * Handles: "tomorrow at 7am", "Saturday at 2pm", "Monday morning", 
 *           "June 14 at 3pm", "next Friday at noon", etc.
 */
function attemptDateParse(str) {
  if (!str) return null;

  // Already a valid ISO date string
  const direct = new Date(str);
  if (!isNaN(direct.getTime()) && direct.getFullYear() > 2020) return direct;

  const input = str.toLowerCase().trim();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Extract time from string
  let hour = 9; // default 9am
  let minute = 0;

  // Match time patterns: 7am, 7:30am, 2pm, 2:30pm, 14:00, noon, morning, afternoon, evening
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

  // Match 24hr time: 14:00, 07:00
  const time24Match = input.match(/(\d{2}):(\d{2})/);
  if (time24Match && !timeMatch) {
    hour = parseInt(time24Match[1]);
    minute = parseInt(time24Match[2]);
  }

  let targetDate = new Date(today);

  // TODAY / TOMORROW
  if (input.includes('today')) {
    // targetDate is already today
  } else if (input.includes('tomorrow')) {
    targetDate.setDate(today.getDate() + 1);
  } else {
    // DAY OF WEEK: monday, tuesday, etc.
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    let foundDay = -1;
    for (let i = 0; i < days.length; i++) {
      if (input.includes(days[i])) { foundDay = i; break; }
    }

    if (foundDay !== -1) {
      const currentDay = today.getDay();
      let daysUntil = foundDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7; // always next occurrence
      if (input.includes('next')) daysUntil += 7; // "next saturday" = 2 weeks if needed
      targetDate.setDate(today.getDate() + daysUntil);
    } else {
      // MONTH NAME: "June 14", "June 14th"
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      let foundMonth = -1;
      for (let i = 0; i < months.length; i++) {
        if (input.includes(months[i])) { foundMonth = i; break; }
      }

      if (foundMonth !== -1) {
        const dayMatch = input.match(/(\d{1,2})(st|nd|rd|th)?/);
        const dayNum = dayMatch ? parseInt(dayMatch[1]) : 1;
        targetDate = new Date(now.getFullYear(), foundMonth, dayNum);
        // If that date already passed this year, use next year
        if (targetDate < today) targetDate.setFullYear(now.getFullYear() + 1);
      } else {
        // Can't parse — return null so we ask customer for clarification
        console.warn(`[Calendar] Could not parse time: "${str}"`);
        return null;
      }
    }
  }

  // Set the time on the target date
  targetDate.setHours(hour, minute, 0, 0);

  // If the resulting time is in the past, return null
  if (targetDate <= now) {
    console.warn(`[Calendar] Parsed date is in the past: ${targetDate} for input "${str}"`);
    return null;
  }

  console.log(`[Calendar] Parsed "${str}" → ${targetDate.toISOString()}`);
  return targetDate;
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
