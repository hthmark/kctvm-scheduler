'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { shouldAlertOwner } = require('./service-ratelimit');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';

function formatTimeForSMS(isoString) {
  if (!isoString) return isoString;
  var date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;
  // Only format if it looks like an ISO string — pass natural language through unchanged
  if (!/^\d{4}-\d{2}-\d{2}T/.test(isoString)) return isoString;
  return date.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

const KNOWLEDGE_BASE = 'KANSAS CITY TV MOUNTING PRICING:\n' +
  'LABOR (per TV):\n' +
  '- TV #1 under 65": $140\n' +
  '- TV #1 65" or larger: $160\n' +
  '- Each additional TV (TV #2, #3, etc.) under 65": $70\n' +
  '- Each additional TV (TV #2, #3, etc.) 65" or larger: $80\n' +
  'ADD-ONS (on top of labor, per TV where applicable):\n' +
  '- Fixed mount (we source and bring it): +$60\n' +
  '- Articulating/full-motion mount for TVs 86" and under (we source and bring it): +$120\n' +
  '- Articulating mount for TVs over 86" (special order, ~2-day delay): +$230\n' +
  '- Brick wall: +$150\n' +
  '- Wire/cable concealment: +$150 (requires existing outlet on same wall)\n' +
  'IMPORTANT: Labor is NEVER included with mount — always separate. Mount add-on only applies if customer does NOT have their own mount.\n' +
  'NEVER add line items that do not exist in the pricing table above. Wire concealment removal fees, setup fees, disposal fees, travel fees, or any charge not listed in KANSAS CITY TV MOUNTING PRICING must never appear in a quote.\n' +
  'HOW TO CALCULATE — always build up TV by TV:\n' +
  '  TV1: [labor for first TV] + [add-ons]\n' +
  '  TV2: [labor for additional TV at $70 or $80] + [add-ons]\n' +
  '  Total = sum of all TVs\n' +
  'EXAMPLE: TV1=55" own mount drywall no wire ($140), TV2=75" articulating mount drywall wire ($80+$120+$150=$350) → Total $490\n' +
  'EXAMPLE: TV1=50" fixed mount brick wire ($140+$60+$150+$150=$500), TV2=40" own mount drywall no wire ($70) → Total $570\n' +
  'When quoting, always show the breakdown per TV then the total. Ask "unless you have your own mount?" when a mount is needed.\n' +
  'We do NOT install new outlets. If no outlet on the wall, ask if they are flexible on TV placement.\n' +
  '- TVs 65" or larger where we supply the mount: After the customer confirms price, send the lift question as its own separate message — do NOT include it in the price quote message. The lift question is ONLY sent after price is confirmed.\n' +
  '  If no one can help with lift: say "Let me get Gabe on this for you" and route to manual.\n\n' +
  'TV SIZE IDENTIFICATION:\n' +
  '- If customer does not know their TV size, say: "There\'s generally a serial, model and make white sticker on the back of the TV. If you\'re able to send that over or take a photo of it I can help you determine the size and which mount would work best!"\n' +
  '- Use the model number to determine size category (under 65" = small, 65"+ = large)\n\n' +
  'SCHEDULING:\n' +
  '- Often same-day or next-day available\n' +
  '- Payment required to lock in appointment\n' +
  '- Payment link sent via text after tech confirms\n\n' +
  'SERVICE AREA:\n' +
  '- KC metro: Lee\'s Summit, Overland Park, Olathe, Independence, Liberty, Gladstone, Blue Springs, North KC and surrounding areas\n\n' +
  'HOW LONG: About 1-1.5 hours per job\n\n' +
  'WHAT WE DO NOT OFFER:\n' +
  '- Ceiling fan installation\n' +
  '- Running HDMI cables through walls or ceiling\n' +
  '- Electrical outlet installation\n' +
  '- Any work that is not TV mounting or wire concealment\n' +
  '- If asked about something we don\'t do, say: "That\'s not something we offer but we\'re happy to help with the TV mounting!"\n\n' +
  'WIRE CONCEALMENT — OUTLET REQUIREMENT:\n' +
  'Before confirming wire concealment for any TV, you MUST ask: "Just to confirm — is there an outlet below or near where the TV will be mounted?" Do not proceed to price confirmation until this is answered.\n' +
  'If customer says NO outlet: "Unfortunately we need an existing outlet on the wall below the TV to conceal the wires, so we wouldn\'t be able to do wire concealment in that case — but we can still mount the TV!"\n' +
  'If customer says YES: proceed normally.\n\n' +
  'MOUNT TYPE — HARD STOP BEFORE PRICING:\n' +
  'If the customer needs a mount (they do NOT have their own) and has NOT said "fixed" or "articulating" in this conversation, STOP. Do NOT calculate or mention any price. Send ONLY this question and nothing else: "Would you want a fixed mount that sits flat against the wall, or an articulating one that lets you tilt and swivel?"\n' +
  'Do not combine this with a price. Do not say the price will depend on the answer. Just ask the question alone and wait.\n' +
  'This is a HARD STOP — no price may appear in any message until mount type is confirmed.\n\n' +
  'MOUNT INVENTORY — AVAILABLE IN STOCK:\n' +
  '- Fixed mount: covers 32"–110" (available)\n' +
  '- Articulating mount: covers 32"–86" (available)\n' +
  'OUT OF STOCK (must order online, ~2-day delay):\n' +
  '- Articulating mount for TVs over 86"\n' +
  '- Fixed mount for TVs over 110"\n' +
  'If a customer needs an articulating mount and their TV is over 86": use $230 for the articulating mount add-on (not $120). Include in the SAME MESSAGE as the price quote: "Just a heads up — since your TV is over 86\", we\'d need to order that mount online which pushes your install out about 2 days." Do NOT send this as a separate message.\n' +
  'If a customer needs a fixed mount and their TV is over 110": use $60 for the fixed mount add-on. Include the same online order notice in the price quote message.\n' +
  'DATE FORMAT FOR SPECIAL ORDER DELAYS: When proposing or confirming a specific appointment date in the context of a special order delay, always spell out the full date — day name, month, and day number. Format: "Saturday, June 28th at 5 PM" — never just "Saturday" or "Saturday at 5pm."\n' +
  'If yes: proceed normally, note the delay in the job.\n' +
  'If no: "No worries! You\'re welcome to source your own mount and we\'ll install it — that would bring the price down to just the labor."\n\n' +
  'CRITICAL LABOR RULE: $140 is ONLY for TVs strictly under 65". Any TV 65" or larger (65", 75", 85", 86", 96", 100", etc.) MUST use $160 for TV #1 labor. Never use $140 for a large TV. A 96" TV = $160 labor, NOT $140.\n\n' +
  'TV SIZE FROM PHOTO: If a customer sends a photo of the TV sticker/label, identify the model number and determine the screen size. Tell them the size and confirm pricing. Use it to also recommend the correct mount type if needed.\n\n' +
  'GABE\'S STYLE: Casual, friendly, short sentences. "Amazing!", "Perfect!", "No worries!" Not corporate. Not a bot. Never mention Walmart, Home Depot, or any store name to customers.';

async function getHistory(phone, afterTimestamp) {
  try {
    var query = supabase
      .from('sms_conversations')
      .select('role, content')
      .eq('phone', phone)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(20);
    if (afterTimestamp) {
      query = query.gt('created_at', afterTimestamp);
    }
    var result = await query;
    return result.data || [];
  } catch (err) {
    console.error('[Concierge] getHistory error:', err.message);
    return [];
  }
}

async function addToHistory(phone, role, content) {
  try {
    await supabase.from('sms_conversations').insert({ phone: phone, role: role, content: content });
  } catch (err) {
    console.error('[Concierge] addToHistory error:', err.message);
  }
}

async function identifyCustomer(phone) {
  try {
    var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
    var result = await supabase
      .from('jobs')
      .select('id, customer_name, status, preferred_time, city, confirmed_tech_name, confirmed_tech_id, stripe_payment_link, num_tvs, total_price, tv_1_size, tv_1_mount, tv_1_wall, tv_1_wire')
      .or('customer_phone.eq.' + normalized)
      .not('status', 'in', '("cancelled","completed")')
      .order('created_at', { ascending: false })
      .limit(1);
    if (result.data && result.data.length > 0) {
      return { type: 'active', job: result.data[0] };
    }
    var past = await supabase
      .from('jobs')
      .select('id, customer_name, status, preferred_time, city, completed_at')
      .or('customer_phone.eq.' + normalized)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1);
    if (past.data && past.data.length > 0) {
      return { type: 'returning', job: past.data[0] };
    }
  } catch (err) {
    console.error('[Concierge] identifyCustomer error:', err.message);
  }
  return { type: 'new', job: null };
}

// Returns { status: 'outside_hours' | 'conflict' | 'available' }
// MUST be called before any conflict detection — outside_hours and conflict are separate paths
async function checkTimeStatus(parsedDate) {
  var calMod = require('./service-calendar');
  var chicagoHour = parsedDate.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false });
  var hour = parseInt(chicagoHour);
  if (hour < 7 || hour >= 19) return { status: 'outside_hours' };
  var available = false;
  try { available = await calMod.isTimeAvailable(parsedDate); } catch(e) {}
  return { status: available ? 'available' : 'conflict' };
}

async function findFirstSlotTomorrow() {
  var calMod = require('./service-calendar');
  var kcTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  var tParts = kcTomorrow.split('/');
  var tomorrowLocal = new Date(parseInt(tParts[2]), parseInt(tParts[0]) - 1, parseInt(tParts[1]), 7, 0, 0, 0);
  var tOffset = new Date(tomorrowLocal.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  var candidate = new Date(tomorrowLocal.getTime() + (tomorrowLocal - tOffset));

  for (var i = 0; i < 15; i++) {
    var available = false;
    try { available = await calMod.isTimeAvailable(candidate, 120); } catch(e) { break; }
    if (available) {
      return {
        time: candidate,
        label: candidate.toLocaleString('en-US', {
          timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
        }),
        raw: candidate.toISOString()
      };
    }
    candidate = new Date(candidate.getTime() + 90 * 60 * 1000);
    var minStr = candidate.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: false });
    var minM = minStr.match(/(\d+):(\d+)/);
    if (minM && parseInt(minM[1]) * 60 + parseInt(minM[2]) > 19 * 60) break;
  }
  return null;
}

async function findNextAvailableTime(requestedTime) {
  var calendarModule = require('./service-calendar');
  var isTimeAvailable = calendarModule.isTimeAvailable;
  var attemptDateParse = calendarModule.attemptDateParse;
  // Note: canonical implementation now lives in service-calendar.js — keeping this
  // copy here so the concierge can call it directly without re-requiring below.

  var getChicagoMinutesOf = function(d) {
    var p = d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: false });
    var mx = p.match(/(\d+):(\d+)/);
    if (!mx) return 720;
    return parseInt(mx[1]) * 60 + parseInt(mx[2]);
  };

  var isAfterHoursRequest = false;

  if (requestedTime) {
    var parsed = attemptDateParse(requestedTime);
    console.log('[Concierge] Requested time: "' + requestedTime + '" parsed to: ' + (parsed ? parsed.toISOString() : 'null'));
    if (parsed && parsed > new Date()) {
      // Business-hours check first — outside 7am–7pm KC means after-hours, not a conflict
      var reqMins = getChicagoMinutesOf(parsed);
      if (reqMins >= 7 * 60 && reqMins <= 19 * 60) {
        var avail = false;
        try { avail = await isTimeAvailable(parsed); } catch(e) {}
        if (avail) {
          var timeStr = parsed.toLocaleString('en-US', {
            timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
            hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
          });
          return { time: parsed, label: timeStr, raw: parsed.toISOString(), exact: true };
        }
      } else {
        console.log('[Concierge] Requested time ' + parsed.toISOString() + ' is outside business hours (' + reqMins + ' mins) — returning first slot tomorrow');
        isAfterHoursRequest = true;
      }
    }
  }

  if (isAfterHoursRequest) {
    var tSlot = await findFirstSlotTomorrow().catch(() => null);
    if (tSlot) return { time: tSlot.time, label: tSlot.label, raw: tSlot.raw, exact: false, afterHours: true };
    return null;
  }

  var now = new Date();
  var candidate = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  var minutes = candidate.getMinutes();
  if (minutes < 30) {
    candidate.setMinutes(30, 0, 0);
  } else {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  }
  // Enforce business hours 8am–7pm KC time (last start 7:00 PM, job ends 8:30 PM)
  var getChicagoMinutes = function(d) {
    var parts = d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: false });
    var m = parts.match(/(\d+):(\d+)/);
    if (!m) return 720;
    return parseInt(m[1]) * 60 + parseInt(m[2]);
  };
  var safetyCount = 0;
  while (safetyCount++ < 48) {
    var mins = getChicagoMinutes(candidate);
    if (mins >= 8 * 60 && mins <= 19 * 60) break;
    // Outside window — jump to next day 8am KC time
    var nextDay = new Date(candidate);
    nextDay.setDate(nextDay.getDate() + (mins > 19 * 60 ? 1 : 0));
    var dateStr = nextDay.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
    var parts = dateStr.split('/');
    candidate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]), 8, 0, 0, 0);
    var offset = new Date(candidate.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    candidate = new Date(candidate.getTime() + (candidate - offset));
  }

  for (var i = 0; i < 20; i++) {
    try {
      var available = await isTimeAvailable(candidate);
      if (available) {
        var label = candidate.toLocaleString('en-US', {
          timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
        });
        return { time: candidate, label: label, raw: candidate.toISOString(), exact: false, afterHours: isAfterHoursRequest };
      }
    } catch (err) {
      console.error('[Concierge] Calendar check error:', err.message);
      break;
    }
    candidate = new Date(candidate.getTime() + 90 * 60 * 1000);
  }
  return null;
}

function buildSystemPrompt(customerType, job, nextSlot) {
  var context = '';

  if (customerType === 'active' && job) {
    var isPrePayment = ['new','scheduling','awaiting_time_confirm','scheduling_conflict','tech_search','awaiting_tech_reply'].includes(job.status);
    var isPostPayment = ['awaiting_payment','confirmed'].includes(job.status);

    if (isPostPayment) {
      context = 'ACTIVE JOB — POST BOOKING: This customer has an active job that is already booked.\n' +
        'Name: ' + job.customer_name + '\n' +
        'Status: ' + job.status + '\n' +
        'Time: ' + job.preferred_time + '\n' +
        'City: ' + job.city + '\n' +
        'Tech: ' + (job.confirmed_tech_name || 'being assigned') + '\n\n' +
        'POST-BOOKING CHANGE RULES:\n' +
        '- If they want to ADD another TV: collect the new TV details (size, mount, wall, wire), calculate the add-on price, confirm with them, then alert Gabe to update the job and send a new invoice. Say: "Absolutely! Let me get the details for the additional TV and I\'ll update your booking right away."\n' +
        '- If they want to ADD wire concealment: confirm the price (+$150), say you\'ll update the booking, alert Gabe.\n' +
        '- If they want to change the TIME before tech arrives: collect new time, say "Let me check that for you!" and alert Gabe to reschedule.\n' +
        '- If they ask about something we don\'t offer: decline gracefully.\n' +
        '- For ANY job change: after collecting details, say "Let me sort that out for you and I\'ll be right back with you!" then alert Gabe.\n' +
        '- If payment is pending, remind them their payment link was already sent.\n';
    } else {
      context = 'ACTIVE JOB — PRE-BOOKING: This customer has a job in progress but not yet confirmed.\n' +
        'Name: ' + job.customer_name + '\n' +
        'Status: ' + job.status + '\n' +
        'Time: ' + job.preferred_time + '\n' +
        'City: ' + job.city + '\n' +
        'Respond based on where they are in the process.\n';
    }
  } else if (customerType === 'returning' && job) {
    context = 'RETURNING CUSTOMER: Been with us before.\n' +
      'Name: ' + job.customer_name + '\n' +
      'Previous job: ' + job.city + ', ' + job.preferred_time + '\n' +
      'Greet them warmly by name and reference their previous experience.\n';
  } else {
    context = 'NEW CUSTOMER CONVERSATION FLOW:\n' +
      'STEP 1 — FIRST MESSAGE: Introduce yourself as Gabe from Kansas City TV Mounting, thank them for reaching out, answer their question, AND ask for their name ("Do you mind if I grab your name?") — all in one message. Do NOT wait for their name before moving forward.\n' +
      'STEP 2 — COLLECT JOB DETAILS (in this order, one or two questions at a time):\n' +
      '  a) TV size in inches\n' +
      '  b) Do they have their own mount? If no, ask: "Would you want a fixed mount that sits flat against the wall, or an articulating one that lets you tilt and swivel?" Do NOT price anything until they answer.\n' +
      '  c) Wall type — "Is it a normal drywall wall or is it brick?"\n' +
      '  d) Wire concealment — do they want cables hidden in the wall?\n' +
      'Keep collecting details even if you do not have their name yet. Do not stall waiting for a name.\n' +
      'STEP 3 — SOFT CLOSE: Once you have all 4 job details (size, mount type must be fixed/articulating/own — never unknown, wall, wire), calculate the total price and send the soft close:\n' +
      '  If you have their name: "Great [name]! It\'ll be $[X] total — does that work for you?"\n' +
      '  If you do NOT have their name: "Great! It\'ll be $[X] total — does that work for you?"\n' +
      'STEP 4 — AFTER PRICE CONFIRMED — follow this exact sequence, one step per message:\n' +
      '  4a) NAME: If no name has been given anywhere in this conversation, ask ONLY: "Do you mind if I grab your name?" — nothing else in that message. Do NOT skip this even if the customer gave a time or city in their first message.\n' +
      '  4b) SCHEDULING: Once you have their name (or if you already had it), ask for scheduling info:\n' +
      '      - If a time was already mentioned anywhere in the conversation: ask for city only — do NOT ask for time again.\n' +
      '      - If no time has been mentioned: ask city and time together: "What city are you in and what time works best for you?"\n' +
      'CRITICAL: NEVER ask for city, preferred time, or scheduling info before the customer has confirmed the price.\n' +
      'CRITICAL: NEVER ask for name and scheduling info in the same message.\n' +
      'CRITICAL: If the customer mentioned a time at any point in the conversation (including their very first message), never ask for a time again — use that time.\n' +
      'Once you have name use it naturally in conversation.\n';
  }

  var slotInstruction = '';
  if (nextSlot) {
    if (nextSlot.exact) {
      slotInstruction = 'TIME AVAILABLE: The customer\'s requested time ' + nextSlot.label + ' IS available (ISO: ' + nextSlot.raw + '). Ask them to confirm it — for bare times (no day) use the BARE TIME HANDLING rule above. For times with a day, say: "Does ' + nextSlot.label + ' work for you?" Use the ISO time as preferred_time in job submission once confirmed.\n';
    } else if (nextSlot.afterHours) {
      slotInstruction = 'AFTER-HOURS REQUEST — OVERRIDE ALL OTHER TIME RULES INCLUDING BARE TIME HANDLING: The customer requested a time outside our 7 AM–7 PM business hours. Do NOT ask "does [time] today?" Do NOT say the time is "taken," "unavailable," or imply a scheduling conflict. Send EXACTLY this message (substitute their first name if known, otherwise omit it): "Hey [name], unfortunately that\'s a little late for us — we run 7 AM to 7 PM. The earliest I have available tomorrow is ' + nextSlot.label + '. Does that work for you?" This is your COMPLETE reply. Use ISO ' + nextSlot.raw + ' as preferred_time once they confirm.\n';
    } else {
      slotInstruction = 'EARLIEST AVAILABLE: slot time is ' + nextSlot.label + ' (ISO: ' + nextSlot.raw + '). Use the ISO time as preferred_time in job submission. Say: "I see we have an opening at ' + nextSlot.label + ' — does that work for you?"\n';
    }
  }

  return 'You are texting for Kansas City TV Mounting (KCTVM) on behalf of Gabe. Keep replies short — this is SMS, max 2-3 sentences. Sound like a real person, not a bot. Never say you are AI.\n\n' +
    context + '\n' +
    slotInstruction + '\n' +
    KNOWLEDGE_BASE + '\n\n' +
    'LARGE TV SEQUENCE (65"+ where we supply the mount) — follow this order strictly, one step per message:\n' +
    'Step 1 — Mount type question (handled in code, not by you)\n' +
    'Step 2 — Once mount type is confirmed: quote price with full breakdown. If special order (articulating >86" or fixed >110"), include the 2-day online order notice AND the special order date in the same message. End with "Does that work for you?"\n' +
    'Step 3 — After customer confirms price: send ONLY the lift question: "Just a heads up — since it\'s 65\"+, we might need a hand lifting it onto the mount. Will someone be able to help us with that? If not, we\'d have to send out two techs which would generally double the price and I\'d hate to do that to you."\n' +
    'Step 4 — After customer confirms lift: the job submits automatically.\n' +
    'NEVER skip a step. NEVER combine steps. One question per turn.\n\n' +
    'SCHEDULING RULES:\n' +
    'Do NOT ask for city or time until the customer has confirmed the price — this is the most important rule.\n' +
    'NEVER suggest or propose a time unless the customer has told you a specific time or said soonest/earliest/asap. If they have not mentioned a time, just ask: "What day and time works best for you?"\n' +
    'NEVER assume a city — use ONLY the exact city the customer stated in this conversation.\n' +
    'MID-CONVERSATION CHANGES:\n' +
    'If a customer changes or adds a job detail (e.g. "actually I need a mount", "add wire concealment", "I want articulating instead"), treat it as a pricing update — NOT a response to any scheduling question. Acknowledge the change, recalculate the total using the pricing rules, and confirm the new price: e.g. "No worries! That\'ll add $60 so your total comes to $200 — does that work for you?" Only after they confirm the updated price should you continue with scheduling.\n' +
    'CRITICAL TIME RULES:\n' +
    '1. Customer requested specific time WITH a day (e.g. "tomorrow at 2pm", "Friday at 11am") and it IS available: say "Perfect, let me check on availability and get right back to you!" — NEVER say you\'re putting them down for a time or mention payment links. The orchestrator handles all confirmations.\n' +
    '2. Proposing earliest available time: say "I see we have an opening at [time] — does that work for you?"\n' +
    '3. When customer confirms earliest time: say "Perfect! You\'ll hear back shortly once we confirm your tech." — same rule, no confirmations from the concierge.\n' +
    (nextSlot && nextSlot.afterHours ? '' :
    'BARE TIME HANDLING (no day specified, e.g. "2pm", "11am", "3:30pm") — only applies when the requested time is within 7 AM–7 PM:\n' +
    'Current Kansas City time: ' + new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }) + '\n' +
    'If the customer gives ONLY a time with no day AND it falls within business hours, ask exactly ONE short question: "[their time] today?" if that time is more than 4 hours from now, or "[their time] tomorrow?" if it is less than 4 hours away or already past. This must be your ENTIRE reply — nothing else. Do NOT say "let me check availability." Do NOT ask for day separately. Their yes/no IS the time confirmation.\n\n') +
    'CRITICAL SMS RULES:\n' +
    'Your response is sent DIRECTLY as an SMS. No asterisks, no bullet points, no brackets, no bold, no internal notes, no job summaries. Plain conversational text only. Never write anything between ** or [] or - lists.\n' +
    'CRITICAL: Never ask more than one question in a single SMS. If you need to ask about mount type AND lift AND price — ask them in separate turns. Price quote first. Then lift question after price is confirmed. Never combine them.\n' +
    'Only say "Let me get Gabe on this for you" for genuine legal/liability issues — absolute last resort.\n';
}

async function handlePostBookingChange(from, body, job, reply) {
  var msgLower = body.toLowerCase();
  var jobChange = require('./service-jobchange');

  // Reschedule request
  var isReschedule = msgLower.includes('reschedule') || msgLower.includes('different time') ||
    msgLower.includes('earlier') || msgLower.includes('later') ||
    msgLower.includes('change') && (msgLower.includes('time') || msgLower.includes('day'));
  var timeMatch = body.match(/\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i);

  if (isReschedule && timeMatch) {
    await jobChange.handleReschedule(job.id, from, body);
    return;
  }

  // Removal request — route to Gabe
  var isRemoval = (msgLower.includes('remove') || msgLower.includes('cancel') || msgLower.includes('skip') || msgLower.includes('without') || msgLower.includes('dont need') || msgLower.includes("don't need")) &&
    (msgLower.includes('wire') || msgLower.includes('mount') || msgLower.includes('tv'));
  if (isRemoval) {
    if (shouldAlertOwner('removal:' + from)) {
      await sendSMS(OWNER_PHONE, '📱 REMOVAL NEEDED\nCustomer: ' + job.customer_name + '\nPhone: ' + from + '\nJob: ' + formatTimeForSMS(job.preferred_time) + ' in ' + job.city + '\nRequest: ' + body);
    }
    return;
  }

  // Add-on — collect details via Claude then process
  // For now alert Gabe — the concierge handles the conversation, then alerts
  if (shouldAlertOwner('addon:' + from)) {
    await sendSMS(OWNER_PHONE, '📱 ADD-ON NEEDED\nCustomer: ' + job.customer_name + '\nPhone: ' + from + '\nJob: ' + formatTimeForSMS(job.preferred_time) + ' in ' + job.city + '\nRequest: ' + body);
  }
}

async function scheduleFollowUp(phone, msg) {
  var keywords = ['how much', 'price', 'cost', 'charge', 'mount', 'tv', 'install', 'available', 'book', 'schedule'];
  if (!keywords.some(function(k) { return msg.toLowerCase().includes(k); })) return;
  try {
    var check = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
    if (check.data) return;
  } catch (e) {}
  // Write to follow_up_queue — edge function cron picks this up (survives Railway restarts)
  // TEST: 1 minute. PROD: change to Date.now() + 3 * 60 * 60 * 1000
  try {
    await supabase.from('follow_up_queue').upsert(
      { phone: phone, scheduled_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), sent: false },
      { onConflict: 'phone', ignoreDuplicates: false }
    );
    console.log('[Concierge] Follow-up queued in Supabase for ' + phone);
  } catch (err) {
    console.error('[Concierge] scheduleFollowUp error:', err.message);
  }
}

async function checkAndCreateJob(phone, history, specialOrderISO) {
  console.log('[checkAndCreateJob] Called for ' + phone + ' with ' + history.length + ' messages');
  if (history.length < 2) {
    console.log('[checkAndCreateJob] BLOCKED — history too short: ' + history.length);
    return false;
  }
  var conversationText = history.map(function(m) {
    return (m.role === 'user' ? 'Customer' : 'KCTVM') + ': ' + m.content;
  }).join('\n');

  var extractPrompt = 'Given this SMS conversation, determine if we have COMPLETE booking details.\n' +
    'Required: customer name, city, confirmed preferred time, number of TVs, TV size, mount type, wall type, wire concealment, total price.\n\n' +
    'Conversation:\n' + conversationText + '\n\n' +
    'PRICING RULES for total_price calculation:\n' +
    '- TV #1 labor: under 65"=$140, 65"+ =$160\n' +
    '- TV #2+ labor: under 65"=$70, 65"+ =$80 (NOT $140/$160 — these are additional TV rates)\n' +
    '- Fixed mount (only if we source it, tv_N_mount="fixed"): +$60 per TV\n' +
    '- Articulating mount 86" and under (only if we source it, tv_N_mount="articulating"): +$120 per TV\n' +
    '- Articulating mount over 86" (special order, tv_N_mount="articulating"): +$230 per TV\n' +
    '- Brick wall: +$150 per TV\n' +
    '- Wire concealment (tv_N_wire="cable"): +$150 per TV\n' +
    '- If tv_N_mount="yes" customer has own mount — NO mount add-on cost\n' +
    'Example: TV1=55" own mount drywall no wire = $140. TV2=75" articulating drywall wire = $80+$120+$150 = $350. Total = $490.\n\n' +
    'LIFT CONFIRMATION — set lift_confirmed:\n' +
    '- lift_confirmed=true if: (a) the TV is under 65", OR (b) the customer owns their own mount (tv_N_mount="yes"), OR (c) KCTVM asked the lift question ("we might need a hand lifting") and the customer replied yes/yeah/sure/ok/no worries/someone can help/etc.\n' +
    '- lift_confirmed=false if: the TV is 65"+ AND we supply the mount AND KCTVM has not yet asked the lift question, OR asked it but customer has not yet replied.\n' +
    '- If customer says no one can help with lift: set lift_confirmed="manual" — do not set ready=true.\n\n' +
    'TIME CONFIRMATION RULES — set time_confirmed=true ONLY when ALL of these are true:\n' +
    '1. The customer has already agreed to the total price earlier in the conversation (not just been quoted it). A customer reply of "yes to both", "yes to all", "both yes", "yep both", or any clear affirmative to multiple questions at once counts as price confirmation.\n' +
    '2. The customer has explicitly agreed to a specific time — not just mentioned one\n' +
    '3. That agreement was a direct response to either: (a) KCTVM acknowledging the customer\'s stated time preference, OR (b) KCTVM proposing a specific alternative slot and the customer saying yes/ok/sure/works/etc., OR (c) KCTVM sent a bare-time confirm like "2pm today?" or "11am tomorrow?" as an entire message and the customer replied yes/yeah/yep/ok/sure/works/sounds good/perfect.\n' +
    'If customer only mentioned a time without being asked to confirm it, or if price has not yet been agreed to, set time_confirmed=false.\n' +
    'OUT-OF-HOURS REDIRECT RULE: If KCTVM sent a message containing "unfortunately that\'s a little late" or "7 AM to 7 PM", that message proposes a NEW time. Any customer yes/ok/sure from BEFORE that message does NOT confirm this new time. time_confirmed=true only if the customer\'s reply comes AFTER that out-of-hours message and directly confirms the new proposed slot.\n' +
    'BARE TIME CONFIRM: If KCTVM sent a message like "2pm today?" or "11am tomorrow?" and customer said yes — set time_confirmed=true AND set preferred_time to "today at [time]" or "tomorrow at [time]" accordingly (e.g. "today at 2pm" or "tomorrow at 11am").\n\n' +
    'preferred_time extraction: if an assistant message contains "(time: ISO_TIMESTAMP)" after proposing a slot, use that ISO string as preferred_time — not the human-readable label next to it.\n\n' +
    'READY RULES:\n' +
    '- ready=true ONLY when: all job details present, price confirmed, time_confirmed=true, AND lift_confirmed=true.\n' +
    '- If lift_confirmed=false: ready=false (lift question must be asked and answered first).\n' +
    '- If lift_confirmed="manual": ready=false (route to Gabe).\n\n' +
    'If ALL details are present and all confirmations done, respond with JSON only:\n' +
    '{"ready":true,"time_confirmed":true,"lift_confirmed":true,"name":"name","city":"exact city from conversation","preferred_time":"specific time e.g. tomorrow at 10am","num_tvs":1,"total_price":200,"tv_1_size":"small or large","tv_1_inches":55,"tv_1_mount":"yes or fixed or articulating","tv_1_wall":"drywall or brick","tv_1_wire":"no or cable"}\n' +
    'tv_1_inches: use actual inch number from conversation. Under 65=small, 65+=large. Unknown small=52, unknown large=75.\n' +
    'tv_1_mount values: "yes" = customer already has their own mount and we do NOT need to source one. "fixed" = we need to source and bring a fixed mount (+$60). "articulating" = we need to source and bring an articulating mount (+$120 or $230 for >86"). If customer says "I have my own mount" or "I have a mount" or "I have a fixed mount" — use "yes", NOT "fixed".\n' +
    'If price confirmed but time not yet explicitly confirmed: {"ready":false,"time_confirmed":false,"lift_confirmed":true_or_false,...all other fields...}\n' +
    'If lift question needed but not yet asked/answered: {"ready":false,"lift_confirmed":false,...}\n' +
    'If lift_confirmed="manual": {"ready":false,"lift_confirmed":"manual",...}\n' +
    'If not complete: {"ready":false}\n' +
    'JSON only, no other text.';

  try {
    var r = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: extractPrompt }]
    });
    var text = r.content[0].text.trim().replace(/```json|```/g, '');
    var data = JSON.parse(text);
    console.log('[checkAndCreateJob] Extraction result: ' + JSON.stringify(data));
    if (!data.ready) {
      console.log('[checkAndCreateJob] BLOCKED — Claude says not ready');

      // Handle lift_confirmed="manual" — route to Gabe
      if (data.lift_confirmed === 'manual') {
        var firstName = data.name ? data.name.split(' ')[0] : 'there';
        var lastLiftMsg = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
        var alreadyRouted = lastLiftMsg && /let me get gabe/i.test(lastLiftMsg.content);
        if (!alreadyRouted) {
          var manualMsg = 'No worries — let me get Gabe on this for you and he\'ll sort out the two-tech situation!';
          await addToHistory(phone, 'assistant', manualMsg);
          await sendSMS(phone, manualMsg);
          if (shouldAlertOwner('lift:' + phone)) {
            await sendSMS(OWNER_PHONE, '📱 TWO-TECH JOB\n' + (data.name || phone) + ' — ' + (data.city || 'unknown city') + '\nNo one available for lift. Manual scheduling needed.\nPhone: ' + phone);
          }
        }
        return false;
      }

      // Handle lift_confirmed=false — only AFTER price+time confirmed, never in same turn as price quote
      if (data.lift_confirmed === false && data.time_confirmed === true && data.name) {
        var liftFirstName = data.name.split(' ')[0];
        var lastMsg = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
        var liftAlreadyAsked = lastMsg && /hand lifting|two techs/i.test(lastMsg.content);
        if (!liftAlreadyAsked) {
          var liftMsg = 'Just a heads up — since it\'s 65"+, we might need a hand lifting it onto the mount. Will someone be able to help us with that? If not, we\'d have to send out two techs which would generally double the price and I\'d hate to do that to you.';
          await addToHistory(phone, 'assistant', liftMsg);
          await sendSMS(phone, liftMsg);
          console.log('[checkAndCreateJob] Lift question sent hardcoded for ' + phone);
        } else {
          console.log('[checkAndCreateJob] Lift question already asked — waiting for reply');
        }
        return false;
      }

      return false;
    }

    if (!data.time_confirmed) {
      console.log('[checkAndCreateJob] BLOCKED — time not yet confirmed by customer');
      // Use this opportunity to proactively check availability and prompt customer to confirm
      if (data.preferred_time) {
        var calModCheck = require('./service-calendar');
        var parsedCheck = calModCheck.attemptDateParse(data.preferred_time);
        if (parsedCheck && parsedCheck > new Date()) {
          var firstName = data.name ? data.name.split(' ')[0] : 'there';
          var timeStatus = await checkTimeStatus(parsedCheck);

          if (timeStatus.status === 'outside_hours') {
            // ── OUTSIDE HOURS ─────────────────────────────────────────────────
            // Completely separate from conflict — never use conflict language here
            console.log('[checkAndCreateJob] Pre-confirm outside_hours — redirecting to tomorrow morning');
            var tSlotPC = await findFirstSlotTomorrow().catch(() => null);
            var lastAsstPC = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
            var alreadyProposedPC = lastAsstPC && /7 AM to 7 PM|late for us/i.test(lastAsstPC.content);
            if (!alreadyProposedPC) {
              var ahMsgPC = tSlotPC
                ? 'Hey ' + firstName + ', unfortunately that\'s a little late for us — we run 7 AM to 7 PM. The earliest I have available tomorrow is ' + tSlotPC.label + '. Does that work for you?'
                : 'Hey ' + firstName + ', unfortunately that\'s a little late for us — we run 7 AM to 7 PM. What morning time works for you?';
              await addToHistory(phone, 'assistant', tSlotPC ? ahMsgPC + ' (time: ' + tSlotPC.raw + ')' : ahMsgPC);
              await sendSMS(phone, ahMsgPC);
            }

          } else if (timeStatus.status === 'available') {
            // ── CALENDAR AVAILABLE ────────────────────────────────────────────
            // Concierge owns the customer-facing confirmation message. Record ISO
            // so the extractor can pick it up when the customer confirms.
            var lastAssistantMsg = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
            var isoAlreadyAnnotated = lastAssistantMsg && lastAssistantMsg.content.includes('(time: ' + parsedCheck.toISOString() + ')');
            if (!isoAlreadyAnnotated && lastAssistantMsg) {
              await supabase.from('sms_conversations')
                .update({ content: lastAssistantMsg.content + ' (time: ' + parsedCheck.toISOString() + ')' })
                .eq('phone', phone).eq('role', 'assistant').eq('content', lastAssistantMsg.content);
              console.log('[checkAndCreateJob] Time available — ISO annotated for ' + data.preferred_time);
            } else {
              console.log('[checkAndCreateJob] Time available — ISO already annotated or no prior assistant message');
            }

          } else {
            // ── CALENDAR CONFLICT ─────────────────────────────────────────────
            // Only fires for in-hours times with a genuine booking conflict
            var altSlot = null;
            try { altSlot = await findNextAvailableTime(data.preferred_time); } catch(e) {}
            if (altSlot) {
              var lastAssistant = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
              var alreadyProposed = lastAssistant && /(available|does that work|what time works|today\?|tomorrow\?)/i.test(lastAssistant.content);
              if (!alreadyProposed) {
                var altSmsTxt = 'Hey ' + firstName + ', looks like ' + formatTimeForSMS(data.preferred_time) + ' is already booked — but I have ' + altSlot.label + ' available. Does that work for you?';
                await addToHistory(phone, 'assistant', altSmsTxt + ' (time: ' + altSlot.raw + ')');
                await sendSMS(phone, altSmsTxt);
                console.log('[checkAndCreateJob] Conflict — proposed ' + altSlot.label + ' (' + altSlot.raw + ')');
              } else {
                console.log('[checkAndCreateJob] Conflict already proposed in last message — skipping duplicate');
              }
            }
          }
        }
      }
      return false;
    }

    // Block vague times
    var hasSpecificTime = data.preferred_time && data.preferred_time.match(/\d{1,2}(:\d{2})?\s*(am|pm)/i);
    var vagueTerms = ['soonest', 'earliest', 'asap', 'as soon as', 'requesting', 'available'];
    if (!hasSpecificTime && data.preferred_time && vagueTerms.some(function(t) { return data.preferred_time.toLowerCase().includes(t); })) {
      console.log('[checkAndCreateJob] BLOCKED — vague time: ' + data.preferred_time);
      return false;
    }

    // Special order jobs: force the injected ISO timestamp and skip conflict/hours check
    if (specialOrderISO && data.lift_confirmed === true) {
      console.log('[checkAndCreateJob] Special order job — forcing preferred_time to ' + specialOrderISO);
      data.preferred_time = specialOrderISO;
      console.log('[checkAndCreateJob] SUBMITTING special order job for ' + phone + ' at ' + data.preferred_time);
      var soPayload = Object.assign({}, data, { phone: phone });
      delete soPayload.ready;
      delete soPayload.time_confirmed;
      delete soPayload.lift_confirmed;
      await axios.post(process.env.BASE_URL + '/webhook/quote', soPayload, { headers: { 'Content-Type': 'application/json' } });
      console.log('[checkAndCreateJob] Special order job created for ' + phone);
      return true;
    }

    // Single status check — outside_hours and conflict are completely separate paths
    var calMod = require('./service-calendar');
    var parsedDate = calMod.attemptDateParse(data.preferred_time);
    if (parsedDate && parsedDate > new Date()) {
      var firstName = data.name ? data.name.split(' ')[0] : 'there';
      var dateStatus = await checkTimeStatus(parsedDate);

      if (dateStatus.status === 'outside_hours') {
        // ── OUTSIDE HOURS ───────────────────────────────────────────────────
        // Never reaches calendar check; never uses conflict language
        console.log('[checkAndCreateJob] outside_hours — redirecting to tomorrow morning');
        var morningSlot = await findFirstSlotTomorrow().catch(() => null);
        var lastMsgAH = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
        var alreadyProposedAH = lastMsgAH && /7 AM to 7 PM|late for us/i.test(lastMsgAH.content);
        if (!alreadyProposedAH) {
          var afterHoursMsg = morningSlot
            ? 'Hey ' + firstName + ', unfortunately that\'s a little late for us — we run 7 AM to 7 PM. The earliest I have available tomorrow is ' + morningSlot.label + '. Does that work for you?'
            : 'Hey ' + firstName + ', unfortunately that\'s a little late for us — we run 7 AM to 7 PM. What morning time works for you?';
          await addToHistory(phone, 'assistant', morningSlot ? afterHoursMsg + ' (time: ' + morningSlot.raw + ')' : afterHoursMsg);
          await sendSMS(phone, afterHoursMsg);
        }
        return false;
      }

      if (dateStatus.status === 'conflict') {
        // ── CALENDAR CONFLICT ────────────────────────────────────────────────
        // Only fires for in-hours times; never for outside_hours
        console.log('[checkAndCreateJob] Conflict at "' + data.preferred_time + '" — finding next slot');
        var nextSlot = null;
        try { nextSlot = await findNextAvailableTime(data.preferred_time); } catch(e) {}
        if (nextSlot) {
          var lastMsg = history.slice().reverse().find(function(m) { return m.role === 'assistant'; });
          var alreadyProposedSlot = lastMsg && /available|does that work|what time works/i.test(lastMsg.content);
          if (!alreadyProposedSlot) {
            var conflictSmsTxt = 'Hey ' + firstName + ', looks like ' + formatTimeForSMS(data.preferred_time) + ' is already booked — but I have ' + nextSlot.label + ' available. Does that work for you?';
            await addToHistory(phone, 'assistant', conflictSmsTxt + ' (time: ' + nextSlot.raw + ')');
            await sendSMS(phone, conflictSmsTxt);
            console.log('[checkAndCreateJob] Conflict — proposed ' + nextSlot.label);
          } else {
            console.log('[checkAndCreateJob] Conflict already proposed — skipping duplicate');
          }
        } else {
          var noSlotMsg = 'Hey ' + firstName + ', looks like ' + formatTimeForSMS(data.preferred_time) + ' is already booked and I\'m having trouble finding the next open slot. What other time works for you?';
          await addToHistory(phone, 'assistant', noSlotMsg);
          await sendSMS(phone, noSlotMsg);
        }
        return false;
      }
      // dateStatus.status === 'available' → fall through to job submission
    }

    console.log('[checkAndCreateJob] SUBMITTING job for ' + phone + ' at ' + data.preferred_time);
    var payload = Object.assign({}, data, { phone: phone });
    delete payload.ready;
    delete payload.time_confirmed;
    await axios.post(process.env.BASE_URL + '/webhook/quote', payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('[checkAndCreateJob] Job created for ' + phone);
    return true;
  } catch (err) {
    console.error('[Concierge] checkAndCreateJob error:', err.message);
    return false;
  }
}

function needsMountTypeQuestion(messages) {
  const conversation = messages.map(function(m) { return typeof m.content === 'string' ? m.content : (m.content || []).map(function(c) { return c.text || ''; }).join(' '); }).join(' ');
  const customerNeedsMount = /need.*(mount|mounting)|no.*own.*mount|don't.*have.*mount|need.*fixed|need.*articulating/i.test(conversation)
    && !/i have.*mount|own.*mount|have my own/i.test(conversation);
  const mountTypeConfirmed = /\bfixed\b|\barticulating\b|\bfull.motion\b/i.test(conversation);
  return customerNeedsMount && !mountTypeConfirmed;
}

function getSpecialOrderEarliestDate(requestedTime) {
  if (requestedTime) {
    try {
      var calMod = require('./service-calendar');
      var parsed = calMod.attemptDateParse(requestedTime);
      if (parsed && !isNaN(parsed.getTime())) {
        // Add exactly 72 hours to the ISO timestamp — hour/minute preserved automatically
        return new Date(parsed.getTime() + 72 * 60 * 60 * 1000);
      }
    } catch(e) {}
  }
  // Fallback: 72h from now at 5 PM Chicago
  var now = new Date();
  var result = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  var dateStr = result.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  var parts = dateStr.split('/');
  var chicagoDate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]), 17, 0, 0, 0);
  var offset = new Date(chicagoDate.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return new Date(chicagoDate.getTime() + (chicagoDate - offset));
}

function formatSpecialOrderDate(date) {
  var dayName = date.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'long' });
  var month = date.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'long' });
  var day = parseInt(date.toLocaleString('en-US', { timeZone: 'America/Chicago', day: 'numeric' }));
  var suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
  var time = date.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
  return dayName + ', ' + month + ' ' + day + suffix + ' at ' + time;
}

function needsSpecialOrderMount(messages) {
  var conversation = messages.map(function(m) { return typeof m.content === 'string' ? m.content : (m.content || []).map(function(c) { return c.text || ''; }).join(' '); }).join(' ');
  // Articulating mount + TV over 86"
  var articulatingOver86 = /articulating/i.test(conversation) && /\b(87|88|89|9\d|1\d{2}|200)["″]/i.test(conversation);
  // Fixed mount + TV over 110"
  var fixedOver110 = /fixed/i.test(conversation) && /\b(11[1-9]|1[2-9]\d|[2-9]\d{2})["″]/i.test(conversation);
  return articulatingOver86 || fixedOver110;
}

async function handleConciergeMessage(from, body, mediaUrls) {
  mediaUrls = mediaUrls || [];
  console.log('[Concierge] Message from ' + from + ': "' + body + '"');
  try {
    var info = await identifyCustomer(from);
    console.log('[Concierge] Customer type: ' + info.type);

    // For returning customers, only show history after their last completed job — never mix old booking conversations into a fresh one
    var historyCutoff = (info.type === 'returning' && info.job && info.job.completed_at) ? info.job.completed_at : null;
    var history = await getHistory(from, historyCutoff);
    var msgLower = body.toLowerCase();

    // Detect job change requests for post-booking customers
    var isJobChange = info.type === 'active' && info.job &&
      ['awaiting_payment','confirmed'].includes(info.job.status) &&
      (msgLower.includes('add') || msgLower.includes('change') || msgLower.includes('reschedule') ||
       msgLower.includes('earlier') || msgLower.includes('later') || msgLower.includes('different time') ||
       msgLower.includes('another tv') || msgLower.includes('wire') || msgLower.includes('conceal'));

    // Calendar check
    var wantsEarliestTime = msgLower.includes('soonest') || msgLower.includes('earliest') || msgLower.includes('asap') || msgLower.includes('as soon as') ||
      history.some(function(m) { return m.role === 'user' && (m.content.toLowerCase().includes('soonest') || m.content.toLowerCase().includes('earliest') || m.content.toLowerCase().includes('asap')); });
    var nextSlot = null;
    var cityKeywords = ['springs', 'kansas city', 'overland', 'summit', 'olathe', 'independence', 'liberty', 'gladstone', 'lees', "lee's", 'belton', 'raymore', 'grandview', 'raytown', 'excelsior', 'parkville', 'riverside'];
    var allText = body.toLowerCase() + ' ' + history.map(function(m) { return m.content.toLowerCase(); }).join(' ');
    var hasCity = cityKeywords.some(function(k) { return allText.includes(k); });
    var specificTimeMatch = body.match(/\d{1,2}(:\d{2})?\s*(am|pm)/i);
    var dayMatch = body.match(/\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    var requestedTime = (specificTimeMatch || dayMatch) ? body : null;
    if (wantsEarliestTime && hasCity) {
      nextSlot = await findNextAvailableTime(null);
    } else if (requestedTime && hasCity) {
      nextSlot = await findNextAvailableTime(requestedTime);
    }

    var userContent = [];
    if (mediaUrls && mediaUrls.length > 0) {
      for (var i = 0; i < mediaUrls.length; i++) {
        try {
          var imgResp = await axios.get(mediaUrls[i], { responseType: 'arraybuffer' });
          var b64 = Buffer.from(imgResp.data).toString('base64');
          var ct = imgResp.headers['content-type'] || 'image/jpeg';
          userContent.push({ type: 'image', source: { type: 'base64', media_type: ct, data: b64 } });
        } catch(e) { console.error('[Concierge] Image fetch error:', e.message); }
      }
    }
    if (body && body.trim()) userContent.push({ type: 'text', text: body });
    if (userContent.length === 0) userContent = [{ type: 'text', text: body || '' }];
    var userMessage = userContent.length === 1 && userContent[0].type === 'text'
      ? { role: 'user', content: userContent[0].text }
      : { role: 'user', content: userContent };
    var messages = history.slice(-10).concat([userMessage]);

    // Compute special order date injection if applicable
    var specialOrderPrefix = '';
    var specialOrderISO = null;
    if (needsSpecialOrderMount(messages)) {
      var soDate = getSpecialOrderEarliestDate(requestedTime);
      var soLabel = formatSpecialOrderDate(soDate);
      specialOrderISO = soDate.toISOString();
      specialOrderPrefix = 'SPECIAL ORDER DATE: The earliest available date for this special order mount job is "' + soLabel + '" (ISO: ' + specialOrderISO + '). Use ONLY this date when proposing the install date to the customer. Do not calculate or invent any other date.\n\n';
      console.log('[Concierge] Special order date injected: ' + soLabel + ' (' + specialOrderISO + ')');
    }

    // Hard-coded pre-check: enforce mount type question — skip Claude entirely
    var reply;
    if (info.type === 'new' && needsMountTypeQuestion(messages)) {
      console.log('[Concierge] Mount type pre-check triggered — sending hardcoded reply, skipping Claude');
      var allConvo = messages.map(function(m) { return typeof m.content === 'string' ? m.content : (m.content || []).map(function(c) { return c.text || ''; }).join(' '); }).join(' ');
      var nameMatch = allConvo.match(/(?:name is|i'm|my name's|this is)\s+(\w+)/i);
      var greeting = nameMatch ? 'Hey ' + nameMatch[1] + '!' : 'Hey there!';
      reply = greeting + " Thanks for reaching out — I'm Gabe from Kansas City TV Mounting. Would you want a fixed mount that sits flat against the wall, or an articulating one that lets you tilt and swivel?";
    } else {
      var systemPrompt = specialOrderPrefix + buildSystemPrompt(info.type, info.job, nextSlot);
      var response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        system: systemPrompt,
        messages: messages
      });
      reply = response.content[0].text.trim();
    }
    console.log('[Concierge] Reply: "' + reply + '"');

    await addToHistory(from, 'user', body);
    await addToHistory(from, 'assistant', reply);

    // Handle post-booking changes automatically
    if (isJobChange) {
      await handlePostBookingChange(from, body, info.job, reply);
    }

    // Alert owner for manual escalation
    if (reply.toLowerCase().indexOf('let me get gabe') !== -1) {
      if (shouldAlertOwner('manual:' + from)) {
        await sendSMS(OWNER_PHONE, 'MANUAL NEEDED\nFrom: ' + from + '\nMsg: ' + body);
      }
    }

    // Send reply
    await sendSMS(from, reply);

    // Try to create job if new customer with all details (time+price both confirmed)
    if (info.type === 'new') {
      var confirmedWords = ["that'll work", "that works", "yes", "perfect", "sounds good", "great", "yep", "sure", "ok", "okay", "works for me", "let's do it", "do it", "amazing", "awesome", "confirmed", "book it", "let's do", "that work", "works"];
      var customerConfirmed = confirmedWords.some(function(w) { return msgLower.includes(w); });
      var hasSpecificTimeInHistory = customerConfirmed || history.concat([{role:'user',content:body},{role:'assistant',content:reply}]).some(function(m) {
        return m.role === 'user' && m.content.match(/\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i);
      });
      if (hasSpecificTimeInHistory) {
        var updatedHistory = await getHistory(from, historyCutoff);
        await checkAndCreateJob(from, updatedHistory.concat([{role:'user',content:body},{role:'assistant',content:reply}]), specialOrderISO);
      }
    }

    await scheduleFollowUp(from, body);

  } catch (err) {
    console.error('[Concierge] Error:', err.message, err.stack);
    if (shouldAlertOwner('error:' + from)) {
      await sendSMS(OWNER_PHONE, 'CONCIERGE ERROR\nFrom: ' + from + '\n' + err.message);
    }
    try {
      await sendSMS(from, 'Hey! Thanks for reaching out to Kansas City TV Mounting. We\'ll get back to you shortly!');
    } catch (e) {}
  }
}

module.exports = { handleConciergeMessage };
