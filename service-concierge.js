'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { shouldAlertOwner } = require('./service-ratelimit');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';

const KNOWLEDGE_BASE = 'KANSAS CITY TV MOUNTING PRICING:\n' +
  '- First TV under 65": $140 (labor only, NO mount included)\n' +
  '- First TV 65" or larger: $160 (labor only, NO mount included)\n' +
  '- Each additional TV under 65": $70\n' +
  '- Each additional TV 65"+: $80\n' +
  '- Fixed mount add-on (we source it): +$60\n' +
  '- Articulating/full motion mount add-on (we source it): +$120\n' +
  '- Brick wall: +$150 per TV\n' +
  '- Wire/cable concealment: +$150 per TV (requires existing outlet on same wall)\n' +
  '- IMPORTANT: Base price is labor only. Mounts are NEVER included. Always an add-on.\n' +
  '- When quoting with a mount always ask "unless you have your own mount?" at the end.\n' +
  '- We do NOT install new outlets. If no outlet on the wall, ask if they are flexible on TV placement.\n' +
  '- TVs 65" or larger: Must confirm someone can help with the lift before booking.\n' +
  '  Ask: "Just a heads up - since it\'s 65"+, we might need a hand lifting it onto the mount. Will someone be able to help us with that? If not, we\'d have to send out two techs which would generally double the price of the installation and I\'d hate to do that to you."\n' +
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
  'GABE\'S STYLE: Casual, friendly, short sentences. "Amazing!", "Perfect!", "No worries!" Not corporate. Not a bot. Never mention Walmart, Home Depot, or any store name to customers.';

async function getHistory(phone) {
  try {
    var result = await supabase
      .from('sms_conversations')
      .select('role, content')
      .eq('phone', phone)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(20);
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

async function findNextAvailableTime(requestedTime) {
  var calendarModule = require('./service-calendar');
  var isTimeAvailable = calendarModule.isTimeAvailable;
  var attemptDateParse = calendarModule.attemptDateParse;

  if (requestedTime) {
    var parsed = attemptDateParse(requestedTime);
    console.log('[Concierge] Requested time: "' + requestedTime + '" parsed to: ' + (parsed ? parsed.toISOString() : 'null'));
    if (parsed && parsed > new Date()) {
      var avail = false;
      try { avail = await isTimeAvailable(parsed); } catch(e) {}
      if (avail) {
        var timeStr = parsed.toLocaleString('en-US', {
          timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
        });
        return { time: parsed, label: timeStr, exact: true };
      }
    }
  }

  var now = new Date();
  var candidate = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  var minutes = candidate.getMinutes();
  if (minutes < 30) {
    candidate.setMinutes(30, 0, 0);
  } else {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  }

  for (var i = 0; i < 20; i++) {
    try {
      var available = await isTimeAvailable(candidate);
      if (available) {
        var label = candidate.toLocaleString('en-US', {
          timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
          hour12: true, weekday: 'short', month: 'numeric', day: 'numeric'
        });
        return { time: candidate, label: label, exact: false };
      }
    } catch (err) {
      console.error('[Concierge] Calendar check error:', err.message);
      break;
    }
    candidate = new Date(candidate.getTime() + 30 * 60 * 1000);
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
    context = 'NEW CUSTOMER:\n' +
      'On the VERY FIRST message, introduce yourself as Gabe from Kansas City TV Mounting, thank them for reaching out, ask for their name like "Do you mind if I grab your name?" AND answer their question — all in one message.\n' +
      'When asking about wall type, phrase it helpfully: "Do you know what type of wall you\'re mounting to? Is it a normal wall like drywall or is it brick?"\n' +
      'Keep asking for their name politely until you get it — vary the phrasing each time.\n' +
      'Once you have their name use it naturally.\n' +
      'Collect all details to book: number of TVs, size in inches, mount type, wall type, wire concealment, city, preferred time.\n' +
      'For EACH TV collect ALL four: size, mount, wall, wire concealment — never skip any.\n';
  }

  var slotInstruction = '';
  if (nextSlot) {
    if (nextSlot.exact) {
      slotInstruction = 'TIME CONFIRMED: The customer\'s requested time is available. Say: "That\'ll work! I\'ll put you down for ' + nextSlot.label + ' in [city] but let me confirm with my techs just to be 100% sure — once that\'s done I\'ll reach back out with a payment link and you\'ll be all set!"\n';
    } else {
      slotInstruction = 'EARLIEST AVAILABLE: The next open slot is ' + nextSlot.label + '. Say: "I see we have an opening at ' + nextSlot.label + ' — does that work for you?"\n';
    }
  }

  return 'You are texting for Kansas City TV Mounting (KCTVM) on behalf of Gabe. Keep replies short — this is SMS, max 2-3 sentences. Sound like a real person, not a bot. Never say you are AI.\n\n' +
    context + '\n' +
    slotInstruction + '\n' +
    KNOWLEDGE_BASE + '\n\n' +
    'SCHEDULING RULES:\n' +
    'NEVER suggest or propose a time unless the customer has told you a specific time or said soonest/earliest/asap/today. If they have not mentioned a time, just ask: "What day and time works best for you?"\n' +
    'NEVER assume a city — use ONLY the exact city the customer stated in this conversation. Read it carefully from the history before confirming.\n' +
    'CRITICAL TIME RULES:\n' +
    '1. Customer requested specific time and it IS available: say "That\'ll work! I\'ll put you down for [time] in [city] but let me confirm with my techs just to be 100% sure — once that\'s done I\'ll reach back out with a payment link and you\'ll be all set!"\n' +
    '2. Proposing earliest available time: say "I see we have an opening at [time] — does that work for you?"\n' +
    '3. When customer confirms earliest time: say "Amazing! I\'ll put you down for [time] in [city] but let me confirm with my techs just to be 100% sure — once that\'s done I\'ll reach back out with a payment link and you\'ll be all set!"\n\n' +
    'CRITICAL SMS RULES:\n' +
    'Your response is sent DIRECTLY as an SMS. No asterisks, no bullet points, no brackets, no bold, no internal notes, no job summaries. Plain conversational text only. Never write anything between ** or [] or - lists.\n' +
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
      await sendSMS(OWNER_PHONE, '📱 REMOVAL NEEDED\nCustomer: ' + job.customer_name + '\nPhone: ' + from + '\nJob: ' + job.preferred_time + ' in ' + job.city + '\nRequest: ' + body);
    }
    return;
  }

  // Add-on — collect details via Claude then process
  // For now alert Gabe — the concierge handles the conversation, then alerts
  if (shouldAlertOwner('addon:' + from)) {
    await sendSMS(OWNER_PHONE, '📱 ADD-ON NEEDED\nCustomer: ' + job.customer_name + '\nPhone: ' + from + '\nJob: ' + job.preferred_time + ' in ' + job.city + '\nRequest: ' + body);
  }
}

var followUpTimers = new Map();

async function scheduleFollowUp(phone, msg) {
  var keywords = ['how much', 'price', 'cost', 'charge', 'mount', 'tv', 'install', 'available', 'book', 'schedule'];
  if (!keywords.some(function(k) { return msg.toLowerCase().includes(k); })) return;
  try {
    var check = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
    if (check.data) return;
  } catch (e) {}
  if (followUpTimers.has(phone)) clearTimeout(followUpTimers.get(phone));
  var timer = setTimeout(async function() {
    followUpTimers.delete(phone);
    try {
      var sent = await supabase.from('follow_up_sent').select('phone').eq('phone', phone).single();
      if (sent.data) return;
      var normalized = phone.startsWith('+') ? phone : '+1' + phone.replace(/\D/g, '');
      var active = await supabase.from('jobs').select('id').or('customer_phone.eq.' + normalized).not('status', 'in', '("cancelled","completed")').limit(1);
      if (active.data && active.data.length > 0) return;
      await sendSMS(phone, 'Hey, just following up to see if you were still interested in getting your TV mounted? No worries if not!');
      await supabase.from('follow_up_sent').insert({ phone: phone });
    } catch (err) {
      console.error('[Concierge] Follow-up error:', err.message);
    }
  }, 3 * 60 * 60 * 1000);
  followUpTimers.set(phone, timer);
}

async function checkAndCreateJob(phone, history) {
  if (history.length < 2) return false;
  var conversationText = history.map(function(m) {
    return (m.role === 'user' ? 'Customer' : 'KCTVM') + ': ' + m.content;
  }).join('\n');

  var extractPrompt = 'Given this SMS conversation, determine if we have COMPLETE booking details.\n' +
    'Required: customer name, city, confirmed preferred time, number of TVs, TV size, mount type, wall type, wire concealment, total price.\n\n' +
    'Conversation:\n' + conversationText + '\n\n' +
    'If ALL details are present and customer confirmed a specific time AND agreed to the price, respond with JSON only:\n' +
    '{"ready":true,"name":"name","city":"exact city from conversation","preferred_time":"specific time e.g. tomorrow at 10am","num_tvs":1,"total_price":200,"tv_1_size":"small or large","tv_1_inches":55,"tv_1_mount":"yes or fixed or articulating","tv_1_wall":"drywall or brick","tv_1_wire":"no or cable"}\n' +
    'tv_1_inches: use actual inch number from conversation. Under 65=small, 65+=large. Unknown small=52, unknown large=75.\n' +
    'If not complete: {"ready":false}\n' +
    'JSON only, no other text.';

  try {
    var r = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: extractPrompt }]
    });
    var text = r.content[0].text.trim().replace(/```json|```/g, '');
    var data = JSON.parse(text);
    if (!data.ready) return false;

    // Block vague times
    var hasSpecificTime = data.preferred_time && data.preferred_time.match(/\d{1,2}(:\d{2})?\s*(am|pm)/i);
    var vagueTerms = ['soonest', 'earliest', 'asap', 'as soon as', 'requesting', 'available'];
    if (!hasSpecificTime && data.preferred_time && vagueTerms.some(function(t) { return data.preferred_time.toLowerCase().includes(t); })) {
      console.log('[Concierge] Blocked job submission — time not confirmed yet: ' + data.preferred_time);
      return false;
    }

    var payload = Object.assign({}, data, { phone: phone });
    delete payload.ready;
    await axios.post(process.env.BASE_URL + '/webhook/quote', payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('[Concierge] Job created for ' + phone);
    return true;
  } catch (err) {
    console.error('[Concierge] checkAndCreateJob error:', err.message);
    return false;
  }
}

async function handleConciergeMessage(from, body) {
  console.log('[Concierge] Message from ' + from + ': "' + body + '"');
  try {
    var info = await identifyCustomer(from);
    console.log('[Concierge] Customer type: ' + info.type);

    var history = await getHistory(from);
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

    var messages = history.slice(-10).concat([{ role: 'user', content: body }]);
    var systemPrompt = buildSystemPrompt(info.type, info.job, nextSlot);

    var response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages
    });

    var reply = response.content[0].text.trim();
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

    // Try to create job if new customer with all details
    if (info.type === 'new' || (info.type === 'active' && ['awaiting_time_confirm','scheduling_conflict'].includes(info.job ? info.job.status : ''))) {
      var confirmedWords = ["that'll work", "that works", "yes", "perfect", "sounds good", "great", "yep", "sure", "ok", "okay", "works for me", "let's do it", "do it", "amazing", "awesome"];
      var customerConfirmed = confirmedWords.some(function(w) { return msgLower.includes(w); });
      var hasSpecificTimeInHistory = customerConfirmed || history.concat([{role:'user',content:body}]).some(function(m) {
        return m.role === 'user' && m.content.match(/\d{1,2}(:\d{2})?\s*(am|pm)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i);
      });
      if (hasSpecificTimeInHistory) {
        var updatedHistory = await getHistory(from);
        await checkAndCreateJob(from, updatedHistory.concat([{role:'user',content:body},{role:'assistant',content:reply}]));
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
