const { google } = require('googleapis');

function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
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

function attemptDateParse(str) {
  if (!str) return null;
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  return null;
}

module.exports = { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse };
