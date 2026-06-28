const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse, findNextAvailableTime } = require('./service-calendar');
const { generateTechMessage, analyzeJobPhotos } = require('./service-claude');
const { createPaymentLink, checkPaymentStatus } = require('./service-stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TECH_TIMEOUT_MS = (parseInt(process.env.TECH_REPLY_TIMEOUT_MINUTES) || 30) * 60 * 1000;
const GOOGLE_REVIEW_URL = 'https://g.page/r/CWmvZghawMfzEBM/review';
const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';

function formatPreferredTime(preferredTime) {
  if (!preferredTime) return preferredTime;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(preferredTime)) return preferredTime;
  const d = new Date(preferredTime);
  if (isNaN(d.getTime())) return preferredTime;
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

// ─── WALMART MOUNT LINKS ─────────────────────────────────────────────────────
const MOUNT_LINKS = {
  fixed: {
    small: { label: 'ONN Fixed Mount 32"-86"', url: 'https://www.walmart.com/ip/777842123' },
    large: { label: 'ONN Fixed Mount 80"-110"', url: 'https://www.walmart.com/ip/ONNFIXED-MNT-80-110/13343901384' }
  },
  articulating: {
    small_low:  { label: 'ONN Full Motion 32"-47"', url: 'https://www.walmart.com/ip/onn-Full-Motion-TV-Wall-Mount-for-TVs-32-to-47/593012224' },
    small_high: { label: 'ONN Full Motion 47"-70"', url: 'https://www.walmart.com/ip/onn-Full-Motion-TV-Wall-Mount-for-47-to-70-TVs-Black/384156891' },
    large:      { label: 'ONN Full Motion 50"-86"', url: 'https://www.walmart.com/ip/onn-Full-Motion-TV-Wall-Mount-for-50-to-86-TVs-up-to-15-Tilting/866844895' }
  }
};

// ─── HOME DEPOT WIRE CONCEAL LINKS ───────────────────────────────────────────
const WIRE_CONCEAL_LINKS = [
  { label: 'Brush Plate (1 per TV)', url: 'https://www.homedepot.com/p/Commercial-Electric-1-Gang-Brush-Plastic-Wall-Plate-White-5038-WH/207161871' },
  { label: 'Single Gang Box (1 per TV)', url: 'https://www.homedepot.com/p/Carlon-1-Gang-Non-Metallic-Low-Voltage-Old-Work-Bracket-SC100RR-SC100RR/100160916' }
];

function getMountInfo(mountType, tvSize, tvInches) {
  if (mountType === 'yes' || mountType === 'no' || !mountType) return null;
  const inches = tvInches || (tvSize === 'large' ? 70 : 52);
  if (mountType === 'fixed') {
    if (inches >= 80) return MOUNT_LINKS.fixed.large;
    return MOUNT_LINKS.fixed.small;
  }
  if (mountType === 'articulating') {
    if (inches <= 47) return MOUNT_LINKS.articulating.small_low;
    if (inches <= 70) return MOUNT_LINKS.articulating.small_high;
    if (inches <= 86) return MOUNT_LINKS.articulating.large;
    return null;
  }
  return null;
}

function buildSupplyList(job) {
  const mountItems = [], wireItems = [], brickTVs = [], outOfRangeTVs = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    const mount = job[`tv_${i}_mount`];
    const wall  = job[`tv_${i}_wall`];
    const wire  = job[`tv_${i}_wire`];
    const inches = job[`tv_${i}_inches`];
    if (mount === 'fixed' || mount === 'articulating') {
      const mountInfo = getMountInfo(mount, size, inches);
      if (mountInfo) mountItems.push({ tvNum: i, type: mount, size, inches, ...mountInfo });
      else outOfRangeTVs.push({ tvNum: i, mount, size, inches });
    }
    if (wire === 'cable') wireItems.push({ tvNum: i });
    if (wall === 'brick') brickTVs.push({ tvNum: i });
  }
  return { mountItems, wireItems, brickTVs, outOfRangeTVs };
}

function calculateBasePayout(job) {
  let payout = 0, tvCount = 0;
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;
    tvCount++;
    payout += tvCount === 1 ? 60 : 40;
    if (job[`tv_${i}_wire`] === 'cable') payout += 40;
  }
  return payout;
}

async function updateJob(jobId, updates) {
  const { error } = await supabase.from('jobs')
    .update({ ...updates, updated_at: new Date().toISOString() }).eq('id', jobId);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

async function processNewJob(job) {
  console.log(`[Orchestrator] processNewJob START — job ${job.id} preferred_time="${job.preferred_time}"`);
  await updateJob(job.id, { status: 'scheduling' });

  const preferredDate = attemptDateParse(job.preferred_time);
  console.log(`[Orchestrator] attemptDateParse result: ${preferredDate ? preferredDate.toISOString() : 'null'}`);

  if (!preferredDate || preferredDate <= new Date()) {
    console.warn(`[Orchestrator] Job ${job.id} has unparseable/past time — this should not happen (concierge should verify first)`);
    await updateJob(job.id, { status: 'awaiting_time_confirm' });
    return;
  }

  const eventId = await createJobEvent(job, preferredDate);
  console.log(`[Orchestrator] Calendar event created: ${eventId}`);
  await updateJob(job.id, { status: 'tech_search', scheduled_time: preferredDate.toISOString(), calendar_event_id: eventId, tech_search_index: 0 });
  console.log(`[Orchestrator] updateJob → tech_search (job ${job.id})`);

  const { outOfRangeTVs } = buildSupplyList(job);
  if (outOfRangeTVs.length > 0) {
    const tvNums = outOfRangeTVs.map(t => `TV${t.tvNum} (${t.inches || t.size}", ${t.mount})`).join(', ');
    console.log(`[Orchestrator] Out-of-range TVs detected: ${tvNums} — alerting owner, continuing dispatch`);
    const firstName = job.customer_name ? job.customer_name.split(' ')[0] : job.customer_name;
    await sendSMS(OWNER_PHONE,
      `Heads up — ${firstName} needs a special order mount (${tvNums}). Job is ${formatPreferredTime(job.preferred_time)} in ${job.city}. Order the mount before then.\nJob ID: ${job.id}`
    );
  }

  console.log(`[Orchestrator] Dispatching to tech for job ${job.id}`);
  await dispatchToNextTech(job.id);
  console.log(`[Orchestrator] processNewJob END — job ${job.id}`);
}

async function dispatchToNextTech(jobId) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  const { data: techs } = await supabase.from('technicians').select('*').eq('active', true).order('priority', { ascending: true });
  const index = job.tech_search_index || 0;
  if (index >= techs.length) {
    await updateJob(jobId, { status: 'no_tech_available' });
    if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
    await sendSMS(job.customer_phone, `Hi ${job.customer_name.split(' ')[0]}, unfortunately we don't have a technician available for your requested time. Can we schedule a different time?`);
    return;
  }
  const tech = techs[index];
  const message = await generateTechMessage(job, tech);
  await sendSMS(tech.phone, message);
  await updateJob(jobId, { status: 'awaiting_tech_reply', current_tech_id: tech.id, current_tech_name: tech.name, tech_notified_at: new Date().toISOString(), tech_search_index: index });
  await supabase.from('tech_contacts').insert({ job_id: jobId, tech_id: tech.id, tech_name: tech.name, message_sent: message, sent_at: new Date().toISOString(), status: 'pending' });
  setTimeout(() => checkTechTimeout(jobId, tech.id), TECH_TIMEOUT_MS);
  console.log(`[Orchestrator] Job ${jobId} — dispatched to tech ${tech.name} (index ${index})`);
}

async function handleTechReply(jobId, techId, reply) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (job.status !== 'awaiting_tech_reply' || job.current_tech_id !== techId) return;
  const normalized = reply.trim().toLowerCase();
  await supabase.from('tech_contacts').update({ status: normalized === 'yes' ? 'accepted' : 'declined', replied_at: new Date().toISOString() }).eq('job_id', jobId).eq('tech_id', techId);
  if (normalized === 'yes') {
    // If customer already paid (confirmed_tech_id set and paid_at present), this is a reschedule
    // confirmation — don't re-send payment link, just re-confirm the updated time
    if (job.confirmed_tech_id && job.paid_at) {
      const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
      if (job.calendar_event_id) await confirmJobEvent(job.calendar_event_id, tech ? tech.name : null);
      await updateJob(jobId, { status: 'confirmed', confirmed_tech_id: techId, confirmed_tech_name: tech ? tech.name : job.current_tech_name });
      const displayTime = formatPreferredTime(job.preferred_time);
      if (tech) await sendSMS(tech.phone, `Great, you're all set for the rescheduled ${job.city} job at ${displayTime}! See you then ${tech.name.split(' ')[0]}.`);
      await sendSMS(job.customer_phone, `You're all set, ${job.customer_name.split(' ')[0]} — rescheduled to ${displayTime}!`);
      console.log(`[Orchestrator] Job ${jobId} reschedule confirmed by tech ${techId} → confirmed`);
    } else {
      await techAccepted(job, techId);
    }
  } else {
    await updateJob(jobId, { tech_search_index: job.tech_search_index + 1 });
    await dispatchToNextTech(jobId);
  }
}

async function techAccepted(job, techId) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  if (job.calendar_event_id) await confirmJobEvent(job.calendar_event_id, tech.name);
  const paymentUrl = await createPaymentLink(job);
  await updateJob(job.id, { status: 'awaiting_payment', confirmed_tech_id: techId, confirmed_tech_name: tech.name, stripe_payment_link: paymentUrl, payment_link_sent_at: new Date().toISOString() });
  const displayTime = formatPreferredTime(job.preferred_time);
  await sendSMS(tech.phone, `Great, you're confirmed for the job in ${job.city} at ${displayTime}! We'll send you the full address and supply list once the customer pays. Thanks ${tech.name.split(' ')[0]}!`);
  await sendSMS(job.customer_phone, `Great news, ${job.customer_name.split(' ')[0]}! Your TV mounting is confirmed for ${displayTime} with ${tech.name.split(' ')[0]}. Please complete payment and provide your full installation address here: ${paymentUrl}`);
  setTimeout(() => checkPaymentReminder(job.id, '2hr'), 2 * 60 * 60 * 1000);
}

async function checkTechTimeout(jobId, techId) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (job.status === 'awaiting_tech_reply' && job.current_tech_id === techId) {
    await supabase.from('tech_contacts').update({ status: 'timeout' }).eq('job_id', jobId).eq('tech_id', techId);
    await updateJob(jobId, { tech_search_index: job.tech_search_index + 1 });
    await dispatchToNextTech(jobId);
  }
}

async function checkPaymentReminder(jobId, stage) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (job.status !== 'awaiting_payment') return;
  const { paid, address } = await checkPaymentStatus(jobId);
  if (paid) { await handlePaymentComplete(job, address); return; }
  if (stage === '2hr') {
    await sendSMS(job.customer_phone, `Hi ${job.customer_name.split(' ')[0]}, just a reminder to complete your payment to lock in your TV mounting appointment: ${job.stripe_payment_link}`);
    const scheduledTime = new Date(job.scheduled_time);
    const warningTime = new Date(scheduledTime.getTime() - 4 * 60 * 60 * 1000);
    const msUntilWarning = warningTime.getTime() - Date.now();
    if (msUntilWarning > 0) {
      setTimeout(() => checkPaymentReminder(jobId, 'pre_job'), msUntilWarning);
    } else {
      await cancelJob(jobId, 'payment_not_received');
    }
  } else if (stage === 'pre_job') {
    await sendSMS(job.customer_phone, `Hi ${job.customer_name.split(' ')[0]}, your appointment is today but payment hasn't been completed. Please pay now or it will be cancelled: ${job.stripe_payment_link}`);
    setTimeout(async () => {
      const { data: latest } = await supabase.from('jobs').select('*').eq('id', jobId).single();
      if (latest.status === 'awaiting_payment') await cancelJob(jobId, 'payment_not_received');
    }, 30 * 60 * 1000);
  }
}

async function handlePaymentComplete(job, address) {
  await updateJob(job.id, { status: 'confirmed', customer_address: address, paid_at: new Date().toISOString() });

  // Re-fetch job to get current state — add-ons may have updated TV fields and base_payout after dispatch
  const { data: freshJob } = await supabase.from('jobs').select('*').eq('id', job.id).single();
  job = freshJob || job;

  const { data: tech } = await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single();
  const { mountItems, wireItems, brickTVs } = buildSupplyList(job);

  const tvLines = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null') continue;
    const inches = job[`tv_${i}_inches`];
    const sizeLabel = inches ? `${inches}"` : (size === 'small' ? 'under 65"' : '65"+');
    const mount = job[`tv_${i}_mount`];
    const mountLabel = mount === 'yes' ? 'has mount' : mount === 'fixed' ? 'fixed mount needed' : mount === 'articulating' ? 'articulating mount needed' : mount;
    const wallLabel = job[`tv_${i}_wall`] === 'brick' ? 'BRICK WALL' : 'drywall';
    const wireLabel = job[`tv_${i}_wire`] === 'cable' ? 'wire concealment' : 'no wire concealment';
    tvLines.push(`TV${i}: ${sizeLabel}, ${mountLabel}, ${wallLabel}, ${wireLabel}`);
  }

  let supplySection = '';
  if (mountItems.length > 0) {
    supplySection += `\n\n🛒 MOUNTS — pick up from Walmart:`;
    mountItems.forEach(m => { supplySection += `\nTV${m.tvNum} (${m.inches || m.size}") — ${m.label}: ${m.url}`; });
  }
  if (wireItems.length > 0) {
    supplySection += `\n\n🛒 WIRE CONCEAL SUPPLIES (${wireItems.length}x each) — Home Depot:`;
    WIRE_CONCEAL_LINKS.forEach(item => { supplySection += `\n${item.label}: ${item.url}`; });
  }
  if (brickTVs.length > 0) {
    const brickNums = brickTVs.map(t => `TV${t.tvNum}`).join(', ');
    supplySection += `\n\n🧱 BRICK — ${brickNums}: Bring masonry drill bits + anchors!`;
  }

  // Use base_payout from DB (updated by add-on handler) — do not recalculate from stale fields
  const basePayout = parseFloat(job.base_payout) || calculateBasePayout(job);
  console.log(`[Orchestrator] Confirmed tech message — payout: $${basePayout}, TVs: ${tvLines.join(' | ')}`);

  const displayJobTime = formatPreferredTime(job.preferred_time);
  const techMsg = `Job confirmed & paid!\n${job.customer_name} — ${address}\nTime: ${displayJobTime}\n\n${tvLines.join('\n')}${supplySection}\n\nBase payout: $${basePayout}\nSend photos + receipts via MMS and reply "Done" when finished. Thanks ${tech.name.split(' ')[0]}!`;
  console.log(`[Orchestrator] Tech msg length: ${techMsg.length} chars | body: ${techMsg}`);
  if (techMsg.length > 1580) {
    const part1 = `Job confirmed & paid!\n${job.customer_name} — ${address}\nTime: ${displayJobTime}\n\n${tvLines.join('\n')}\n\nBase payout: $${basePayout}`;
    const part2 = supplySection.trim() + `\n\nSend photos + receipts via MMS and reply "Done" when finished. Thanks ${tech.name.split(' ')[0]}!`;
    await sendSMS(tech.phone, part1);
    await sendSMS(tech.phone, part2);
  } else {
    await sendSMS(tech.phone, techMsg);
  }
  await sendSMS(job.customer_phone, `You're all set, ${job.customer_name.split(' ')[0]}! Payment received. ${tech.name.split(' ')[0]} will be there at ${formatPreferredTime(job.preferred_time)}. See you then!`);
  console.log(`[Orchestrator] Job ${job.id} confirmed — tech and customer notified`);
}

// ─── HANDLE PHOTOS FROM TECH (MMS) ───────────────────────────────────────────
async function handleTechPhotos(jobId, techId, mediaUrls) {
  if (!mediaUrls || mediaUrls.length === 0) return;
  console.log(`[Orchestrator] Processing ${mediaUrls.length} photos for job ${jobId}`);

  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();

  // Use Claude to analyze photos — identify TV installation photos vs receipts
  const { tvPhotos, receiptPhotos, receiptTotal } = await analyzeJobPhotos(mediaUrls, job.num_tvs);

  // Store best TV photos (one per TV) in Supabase
  const photoUpdate = {};
  tvPhotos.forEach((url, i) => {
    if (i < 10) photoUpdate[`tv_${i + 1}_photo`] = url;
  });

  // Store receipt total and photo URLs
  const allReceiptUrls = receiptPhotos.join(',');
  const basePayout = job.base_payout || calculateBasePayout(job);
  const totalPayout = basePayout + (receiptTotal || 0);

  await updateJob(jobId, {
    ...photoUpdate,
    receipt_photos: allReceiptUrls,
    receipt_total: receiptTotal || 0,
    total_payout: totalPayout,
    photos_received_at: new Date().toISOString(),
    payout_status: 'pending_payment',
  });

  console.log(`[Orchestrator] Job ${jobId} — ${tvPhotos.length} TV photos, ${receiptPhotos.length} receipts, receipt total $${receiptTotal}, total payout $${totalPayout}`);

  // Text owner with payout summary
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  const receiptNote = receiptTotal > 0 ? `\nReceipts: $${receiptTotal}` : '\nNo receipts';
  await sendSMS(OWNER_PHONE,
    `💰 PAYOUT NEEDED\n${tech.name}\nJob: ${job.customer_name} — ${job.city}\nBase: $${basePayout}${receiptNote}\nTOTAL: $${totalPayout}\n\nPay via Novo ACH when ready.`
  );
}

async function handleJobCompletion(jobId) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  await updateJob(jobId, { status: 'completed', completed_at: new Date().toISOString() });
  // Thank the tech
  if (job.confirmed_tech_id) {
    const { data: tech } = await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single();
    if (tech) {
      await sendSMS(tech.phone, `Thanks for the help ${tech.name.split(' ')[0]}! Sending the payout your way.`);
    }
  }
  // Send review request to customer
  await sendSMS(job.customer_phone, `Hey ${job.customer_name.split(' ')[0]}! Hope the install went smoothly — we'd love to hear how everything went! If you have a moment, a quick Google review would mean the world to us: ${GOOGLE_REVIEW_URL}`);
  console.log(`[Orchestrator] Job ${jobId} completed — tech thanked, review request sent to customer`);
}

async function cancelJob(jobId, reason) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  await updateJob(jobId, { status: 'cancelled', cancellation_reason: reason, cancelled_at: new Date().toISOString() });
  if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
  if (job.confirmed_tech_id) {
    const { data: tech } = await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single();
    if (tech) await sendSMS(tech.phone, `Hi ${tech.name.split(' ')[0]}, the ${job.city} job on ${formatPreferredTime(job.preferred_time)} has been cancelled. Sorry for the inconvenience!`);
  }
}

// ─── FOLLOW UP ───────────────────────────────────────────────────────────────
async function sendFollowUp(jobId) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  // Only send if still waiting on customer
  if (job.status !== 'awaiting_time_confirm' && job.status !== 'scheduling_conflict') return;
  // Check if we already sent a follow-up to this number ever — one and done
  const { data: alreadySent } = await supabase
    .from('follow_up_sent').select('phone').eq('phone', job.customer_phone).single();
  if (alreadySent) {
    console.log(`[Orchestrator] Follow-up already sent to ${job.customer_phone} before — skipping`);
    return;
  }
  const firstName = job.customer_name.split(' ')[0];
  await sendSMS(job.customer_phone, `Hey ${firstName}, just following up to see if you were still interested in getting your TV mounted? No worries if not!`);
  await supabase.from('follow_up_sent').insert({ phone: job.customer_phone });
  await updateJob(jobId, { follow_up_sent_at: new Date().toISOString() });
  console.log(`[Orchestrator] Follow-up sent to ${job.customer_name} — marked permanently`);
}

// ─── RESCHEDULE FLOW ──────────────────────────────────────────────────────────

function extractTimeText(text) {
  var match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;
  var hour = parseInt(match[1]);
  var minute = match[2] ? parseInt(match[2]) : 0;
  var ampm = match[3].toUpperCase();
  var minuteStr = minute > 0 ? ':' + String(minute).padStart(2, '0') : '';
  return hour + minuteStr + ' ' + ampm;
}

function hasDay(text) {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})\b/i.test(text);
}

// ─── TECH MESSAGE ON CONFIRMED JOB ───────────────────────────────────────────
async function handleTechConfirmedMessage(job, techId, body, bodyLower) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();

  // Time-first: if tech message contains a parseable future time different from scheduled_time, treat as reschedule
  const isTimeRange = /\d+\s*(to|-)\s*\d+/.test(body) || /between/i.test(body);
  const hasDayWord = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(body);
  if (!isTimeRange) {
    const parsed = attemptDateParse(body);
    if (parsed && parsed > new Date()) {
      const scheduledMs = job.scheduled_time ? new Date(job.scheduled_time).getTime() : 0;
      if (Math.abs(parsed.getTime() - scheduledMs) > 5 * 60 * 1000) {
        const displayTime = parsed.toLocaleString('en-US', {
          timeZone: 'America/Chicago', weekday: 'short', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true
        });
        if (hasDayWord) {
          // Day is explicit — go straight to customer
          await updateJob(job.id, { status: 'tech_reschedule_customer_confirm', rescheduling_new_time: parsed.toISOString() });
          await sendSMS(job.customer_phone, `Hey ${job.customer_name.split(' ')[0]}, our tech had something come up — would ${displayTime} still work for you?`);
          console.log(`[Orchestrator] Tech ${tech.name} implied reschedule (with day) to ${displayTime} for job ${job.id} — asked customer`);
        } else {
          // Bare time — confirm day with tech first
          const dayLabel = parsed.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'long' });
          const timeLabel = parsed.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
          await updateJob(job.id, { status: 'tech_reschedule_day_confirm', rescheduling_new_time: parsed.toISOString() });
          await sendSMS(tech.phone, `Got it — just to confirm, are you thinking ${timeLabel} this ${dayLabel}?`);
          console.log(`[Orchestrator] Tech ${tech.name} implied reschedule (no day) to ${displayTime} for job ${job.id} — asking tech day confirm`);
        }
        return;
      }
    }
  }

  // Cancel keyword check
  const techCancelKeywords = ["can't make it", "cant make it", "have to cancel", "something came up", "cancel", "won't be able", "wont be able"];
  if (techCancelKeywords.some(k => bodyLower.includes(k))) {
    await handleTechCancelRequest(job, techId);
    return;
  }

  // Reschedule keyword check — no parseable time, so ask for one
  const techReschedKeywords = ["can we move", "reschedule", "can i do a different time", "running behind", "different time", "can i do", "can we make it", "what about", "can we do", "would it work", "is there any way"];
  if (techReschedKeywords.some(k => bodyLower.includes(k))) {
    await handleTechRescheduleRequest(job, techId);
    return;
  }

  console.log(`[Orchestrator] Tech ${tech.name} message on confirmed job ${job.id} — no action matched, ignoring`);
}

// Tech confirms day for a bare-time implied reschedule
async function handleTechRescheduleImpliedDayConfirm(job, techId, messageText) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  const isAffirmative = /^(yes|yeah|yep|yup|sure|ok|okay|correct|confirmed|confirm|exactly|right|that's right|yep that's it)$/i.test(messageText.toLowerCase().trim());

  if (isAffirmative && job.rescheduling_new_time) {
    const parsed = new Date(job.rescheduling_new_time);
    const displayTime = parsed.toLocaleString('en-US', {
      timeZone: 'America/Chicago', weekday: 'short', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
    await updateJob(job.id, { status: 'tech_reschedule_customer_confirm' });
    await sendSMS(job.customer_phone, `Hey ${job.customer_name.split(' ')[0]}, our tech had something come up — would ${displayTime} still work for you?`);
    console.log(`[Orchestrator] Tech ${tech.name} confirmed day for implied reschedule → ${displayTime} for job ${job.id} — asked customer`);
  } else {
    // Tech corrected — ask fresh
    await updateJob(job.id, { status: 'tech_reschedule_pending', rescheduling_new_time: null });
    await sendSMS(tech.phone, `No problem — what day and time works for you?`);
    console.log(`[Orchestrator] Tech ${tech.name} denied day confirm for job ${job.id} — asking fresh`);
  }
}

// ─── TECH-INITIATED CANCEL ────────────────────────────────────────────────────
async function handleTechCancelRequest(job, techId) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  await updateJob(job.id, { status: 'tech_cancel_confirm' });
  await sendSMS(tech.phone, `Just confirming — are you cancelling the ${job.city} job on ${formatPreferredTime(job.preferred_time)}? Reply Yes to confirm.`);
  console.log(`[Orchestrator] Tech ${tech.name} cancel request — awaiting confirmation for job ${job.id}`);
}

async function handleTechCancelConfirm(job, techId, isYes) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  if (isYes) {
    if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
    await updateJob(job.id, {
      status: 'tech_search',
      confirmed_tech_id: null,
      confirmed_tech_name: null,
      current_tech_id: null,
      current_tech_name: null,
      tech_search_index: (job.tech_search_index || 0) + 1,
    });
    await sendSMS(job.customer_phone, `Hey ${job.customer_name.split(' ')[0]}, we had an unexpected scheduling conflict on our end — we're getting you a new tech and will confirm shortly!`);
    console.log(`[Orchestrator] Tech ${tech.name} confirmed cancel for job ${job.id} — dispatching next tech`);
    await dispatchToNextTech(job.id);
  } else {
    await updateJob(job.id, { status: 'confirmed' });
    await sendSMS(tech.phone, `Got it — you're still on for ${formatPreferredTime(job.preferred_time)}. See you then!`);
    console.log(`[Orchestrator] Tech ${tech.name} did not cancel job ${job.id} — restored to confirmed`);
  }
}

// ─── TECH-INITIATED RESCHEDULE ────────────────────────────────────────────────
async function handleTechRescheduleRequest(job, techId) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  await updateJob(job.id, { status: 'tech_reschedule_pending' });
  await sendSMS(tech.phone, `What day and time works for you?`);
  console.log(`[Orchestrator] Tech ${tech.name} wants to reschedule job ${job.id} — asked for new time`);
}

async function handleTechRescheduleTime(job, techId, timeText) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();

  // Fix 2: reject time ranges before attempting to parse
  if (/\d+\s*(to|-)\s*\d+/.test(timeText) || /between/i.test(timeText)) {
    await sendSMS(tech.phone, `Could you give me a specific time rather than a range?`);
    return;
  }

  const parsed = attemptDateParse(timeText);

  // Fix 1: distinguish past/unparseable from generic failure
  if (!parsed) {
    await sendSMS(tech.phone, `Sorry, I couldn't understand that time. Can you send a specific day and time like "Friday at 2pm"?`);
    return;
  }
  if (parsed <= new Date()) {
    await sendSMS(tech.phone, `That time looks like it's already passed — what day and time were you thinking?`);
    return;
  }
  const displayTime = parsed.toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
  await updateJob(job.id, { status: 'tech_reschedule_customer_confirm', rescheduling_new_time: parsed.toISOString() });
  await sendSMS(job.customer_phone, `Hey ${job.customer_name.split(' ')[0]}, our tech had something come up — would ${displayTime} still work for you?`);
  console.log(`[Orchestrator] Tech ${tech ? tech.name : techId} proposed ${displayTime} to customer for job ${job.id}`);
}

async function handleTechRescheduleCustReply(job, messageText) {
  const { data: tech } = job.confirmed_tech_id
    ? await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single()
    : { data: null };
  const isAffirmative = /^(yes|yeah|yep|yup|sure|ok|okay|works|that works|sounds good|perfect|great|absolutely|definitely|correct|confirmed|confirm|go ahead|sounds great|works for me|good|all good)$/i.test(messageText.toLowerCase().trim());

  if (isAffirmative) {
    const newDate = new Date(job.rescheduling_new_time);
    await _applyTechRescheduleTime(job, tech, newDate);
  } else {
    // Customer is countering with their own time
    const parsed = attemptDateParse(messageText);
    if (parsed && parsed > new Date()) {
      if (hasDay(messageText)) {
        // Day is explicit — ask tech if they can do the customer's counter-time
        await _askTechToReconfirm(job, tech, parsed);
      } else {
        // Time only, no day — confirm the day with the customer first
        const dayLabel = parsed.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'long' });
        const timeLabel = parsed.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
        await updateJob(job.id, { status: 'tech_reschedule_day_confirm', rescheduling_new_time: parsed.toISOString() });
        await sendSMS(job.customer_phone, `Got it — just to confirm, are you thinking ${timeLabel} this ${dayLabel}?`);
        console.log(`[Orchestrator] Customer countered with time-only "${messageText}" for job ${job.id} — asking day confirm`);
      }
    } else {
      // No parseable time — ask what works
      await updateJob(job.id, { status: 'confirmed', rescheduling_new_time: null });
      await sendSMS(job.customer_phone, `No problem — what day and time works better for you?`);
      if (tech) await sendSMS(tech.phone, `The customer can't do that time — we'll work out a new time with them and let you know.`);
      console.log(`[Orchestrator] Customer rejected tech reschedule for job ${job.id} — routing back to normal flow`);
    }
  }
}

async function _askTechToReconfirm(job, tech, newDate) {
  const displayTime = formatPreferredTime(newDate.toISOString());
  await updateJob(job.id, { status: 'tech_reschedule_tech_reconfirm', rescheduling_new_time: newDate.toISOString() });
  if (tech) await sendSMS(tech.phone, `Hey ${tech.name.split(' ')[0]}, the customer is looking at ${displayTime} instead — does that work for you? Reply Yes or No.`);
  console.log(`[Orchestrator] Customer countered with ${displayTime} for job ${job.id} — asked tech to reconfirm`);
}

async function handleTechRescheduleReconfirm(job, techId, isYes) {
  const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
  const newDate = new Date(job.rescheduling_new_time);
  const displayTime = formatPreferredTime(job.rescheduling_new_time);

  if (isYes) {
    if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
    const newEventId = await createJobEvent(job, newDate);
    if (tech) await confirmJobEvent(newEventId, tech.name);
    await updateJob(job.id, {
      status: 'confirmed',
      preferred_time: job.rescheduling_new_time,
      scheduled_time: newDate.toISOString(),
      calendar_event_id: newEventId,
      rescheduling_new_time: null,
    });
    await sendSMS(job.customer_phone, `You're all set — see you at ${displayTime}!`);
    if (tech) await sendSMS(tech.phone, `You're confirmed for ${displayTime}. Thanks ${tech.name.split(' ')[0]}!`);
    console.log(`[Orchestrator] Tech ${tech ? tech.name : techId} reconfirmed customer counter-time ${displayTime} for job ${job.id}`);
  } else {
    await updateJob(job.id, { status: 'tech_reschedule_customer_confirm', rescheduling_new_time: null });
    await sendSMS(job.customer_phone, `Our tech isn't available at that time — what other time works for you?`);
    console.log(`[Orchestrator] Tech ${tech ? tech.name : techId} rejected customer counter-time for job ${job.id} — asking customer again`);
  }
}

async function _applyTechRescheduleTime(job, tech, newDate) {
  const displayTime = formatPreferredTime(newDate.toISOString());
  if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
  const newEventId = await createJobEvent(job, newDate);
  if (tech) await confirmJobEvent(newEventId, tech.name);
  await updateJob(job.id, {
    status: 'confirmed',
    preferred_time: newDate.toISOString(),
    scheduled_time: newDate.toISOString(),
    calendar_event_id: newEventId,
    rescheduling_new_time: null,
  });
  await sendSMS(job.customer_phone, `You're all set, ${job.customer_name.split(' ')[0]} — see you at ${displayTime}!`);
  if (tech) await sendSMS(tech.phone, `New time confirmed: ${displayTime}. You're all set ${tech.name.split(' ')[0]}!`);
  console.log(`[Orchestrator] Tech reschedule confirmed for job ${job.id} → ${displayTime}`);
}

async function handleTechRescheduleDayConfirm(job, messageText) {
  const { data: tech } = job.confirmed_tech_id
    ? await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single()
    : { data: null };
  const isAffirmative = /^(yes|yeah|yep|yup|sure|ok|okay|works|that works|sounds good|perfect|great|absolutely|definitely|correct|confirmed|confirm|go ahead|sounds great|works for me|good|all good)$/i.test(messageText.toLowerCase().trim());

  if (isAffirmative && job.rescheduling_new_time) {
    const newDate = new Date(job.rescheduling_new_time);
    await _askTechToReconfirm(job, tech, newDate);
  } else {
    // Customer corrected or said no — ask fresh
    await updateJob(job.id, { status: 'confirmed', rescheduling_new_time: null });
    await sendSMS(job.customer_phone, `What day and time works for you?`);
    console.log(`[Orchestrator] Customer denied day confirm for job ${job.id} — asking fresh`);
  }
}

async function handleLateCancellation(job, techId) {
  const firstName = job.customer_name.split(' ')[0];
  if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
  await updateJob(job.id, {
    status: 'tech_search',
    confirmed_tech_id: null,
    confirmed_tech_name: null,
    tech_search_index: (job.tech_search_index || 0) + 1,
  });
  await sendSMS(job.customer_phone, `Hey ${firstName}, we had a tech conflict come up — we're getting you a replacement and will confirm your time shortly. Sorry for the inconvenience!`);
  console.log(`[Orchestrator] Late cancellation by tech ${techId} on job ${job.id} — re-dispatching`);
  await dispatchToNextTech(job.id);
}

async function handleRescheduleRequest(job, messageText) {
  console.log(`[Reschedule] handleRescheduleRequest START — job ${job.id} status="${job.status}" msg="${messageText}"`);
  try {
    // Always confirm with the customer before executing — write rescheduling_new_time first
    let proposedDate = attemptDateParse(messageText);
    console.log(`[Reschedule] attemptDateParse result: ${proposedDate ? proposedDate.toISOString() : 'null'}`);

    if (!proposedDate) {
      // Time-only (no day) — infer today or tomorrow
      const timeText = extractTimeText(messageText);
      console.log(`[Reschedule] extractTimeText="${timeText}" hasDay=${hasDay(messageText)}`);
      if (timeText && !hasDay(messageText)) {
        const todayDate = attemptDateParse('today at ' + timeText);
        proposedDate = (todayDate && todayDate > new Date()) ? todayDate : attemptDateParse('tomorrow at ' + timeText);
        console.log(`[Reschedule] Time-only proposed date: ${proposedDate ? proposedDate.toISOString() : 'null'}`);
      }
    }

    if (!proposedDate) {
      console.log(`[Reschedule] Could not parse time from "${messageText}" — asking customer`);
      await sendSMS(job.customer_phone, `What day and time works better for you?`);
      return;
    }

    // Format a human-readable confirmation label
    const confirmLabel = proposedDate.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    // Write rescheduling_new_time and set status so the next "yes" triggers the full reschedule
    console.log(`[Reschedule] Writing rescheduling_new_time=${proposedDate.toISOString()} for job ${job.id}`);
    try {
      await updateJob(job.id, { status: 'rescheduling_day_confirm', rescheduling_new_time: proposedDate.toISOString() });
      console.log(`[Reschedule] rescheduling_new_time written — job ${job.id} → rescheduling_day_confirm`);
    } catch (dbErr) {
      console.error(`[Reschedule] DB write failed for job ${job.id}:`, dbErr.message);
      throw dbErr;
    }

    await sendSMS(job.customer_phone, `${confirmLabel}? Does that work for you?`);
    console.log(`[Reschedule] Confirmation sent to customer for job ${job.id}: "${confirmLabel}"`);
  } catch (err) {
    console.error(`[Reschedule] handleRescheduleRequest ERROR for job ${job.id}:`, err.message, err.stack);
    await sendSMS(OWNER_PHONE, `RESCHEDULE ERROR\nJob ${job.id} — ${job.customer_name}\n${err.message}`).catch(() => {});
  }
}

async function handleRescheduleConfirmDay(job, messageText) {
  console.log(`[Reschedule] handleRescheduleConfirmDay START — job ${job.id} msg="${messageText}" stored="${job.rescheduling_new_time}"`);
  try {
    const msgLower = messageText.toLowerCase().trim();
    const isAffirmative = /^(yes|yeah|yep|yup|sure|ok|okay|works|that works|that'll work|sounds good|perfect|great|absolutely|definitely|correct|confirmed|confirm|lets do it|let's do it|do it|go ahead|sounds great|works for me|that'll do|good|all good)$/i.test(msgLower);
    console.log(`[Reschedule] isAffirmative=${isAffirmative} hasDay=${hasDay(messageText)}`);

    if (!isAffirmative) {
      // Customer rejected the proposed time or gave a new one — treat as fresh reschedule request
      console.log(`[Reschedule] Not affirmative — routing back through handleRescheduleRequest with: "${messageText}"`);
      await handleRescheduleRequest(job, messageText);
      return;
    }

    const newDate = job.rescheduling_new_time ? new Date(job.rescheduling_new_time) : null;
    console.log(`[Reschedule] Affirmative — using stored time: ${newDate ? newDate.toISOString() : 'null'}`);

    if (!newDate || isNaN(newDate.getTime())) {
      console.log(`[Reschedule] Could not resolve stored date — asking customer again`);
      await sendSMS(job.customer_phone, `What day and time works better for you?`);
      return;
    }

    await _proceedWithRescheduleTime(job, newDate);
  } catch (err) {
    console.error(`[Reschedule] handleRescheduleConfirmDay ERROR for job ${job.id}:`, err.message, err.stack);
    await sendSMS(OWNER_PHONE, `RESCHEDULE ERROR\nJob ${job.id} — ${job.customer_name}\n${err.message}`).catch(() => {});
  }
}

async function _proceedWithRescheduleTime(job, newDate) {
  console.log(`[Reschedule] _proceedWithRescheduleTime START — job ${job.id} newDate=${newDate.toISOString()} confirmed_tech_id=${job.confirmed_tech_id} current_tech_id=${job.current_tech_id}`);
  try {
    // Delete the existing calendar event before checking availability so the job's
    // own event doesn't block the slot the customer is trying to move to.
    if (job.calendar_event_id) {
      await deleteJobEvent(job.calendar_event_id).catch(err =>
        console.warn(`[Reschedule] Could not delete existing calendar event ${job.calendar_event_id}:`, err.message)
      );
      console.log(`[Reschedule] Deleted existing calendar event ${job.calendar_event_id} before availability check`);
    }

    let available = false;
    try {
      available = await isTimeAvailable(newDate);
      console.log(`[Reschedule] isTimeAvailable(${newDate.toISOString()}) = ${available}`);
    } catch (calErr) {
      console.error(`[Reschedule] Calendar check failed for job ${job.id}:`, calErr.message);
      await sendSMS(job.customer_phone, `Got it! Let me check with our team and I'll get back to you shortly.`);
      await sendSMS(OWNER_PHONE, `RESCHEDULE — calendar check failed\nJob ${job.id} — ${job.customer_name} in ${job.city}\nRequested: ${formatPreferredTime(newDate.toISOString())}\nError: ${calErr.message}`);
      return;
    }

    if (!available) {
      console.log(`[Reschedule] Time not available for job ${job.id} — finding alt`);
      const searchFloor = new Date(Math.max(newDate.getTime(), Date.now()));
      const alt = await findNextAvailableTime(searchFloor.toISOString()).catch(() => null);
      if (alt) {
        await updateJob(job.id, { rescheduling_new_time: alt.raw });
        console.log(`[Reschedule] Wrote alt rescheduling_new_time=${alt.raw} for job ${job.id}`);
        await sendSMS(job.customer_phone, `That time is taken — how about ${alt.label}? Does that work?`);
        console.log(`[Reschedule] Proposed alt ${alt.label} to customer`);
      } else {
        await sendSMS(job.customer_phone, `Sorry, none of our techs are available for that time — would you like to try a different day or time?`);
      }
      return;
    }

    // Time is available — use confirmed_tech_id for post-payment jobs, current_tech_id otherwise
    const techId = job.confirmed_tech_id || job.current_tech_id;
    console.log(`[Reschedule] Time available — techId=${techId}`);
    if (!techId) {
      console.warn(`[Reschedule] No tech ID on job ${job.id} — alerting owner`);
      await sendSMS(job.customer_phone, `Got it! Let me check with our team and get back to you shortly.`);
      await sendSMS(OWNER_PHONE, `RESCHEDULE NEEDED (no tech ID)\nJob ${job.id} — ${job.customer_name} in ${job.city}\nNew time: ${formatPreferredTime(newDate.toISOString())}`);
      return;
    }

    const { data: tech, error: techErr } = await supabase.from('technicians').select('*').eq('id', techId).single();
    console.log(`[Reschedule] Tech lookup — id=${techId} found=${!!tech} error=${techErr ? techErr.message : 'none'}`);
    if (!tech) {
      console.warn(`[Reschedule] Tech ${techId} not found for job ${job.id}`);
      await sendSMS(job.customer_phone, `Got it! Let me check with our team and get back to you shortly.`);
      await sendSMS(OWNER_PHONE, `RESCHEDULE NEEDED (tech not found id=${techId})\nJob ${job.id} — ${job.customer_name} in ${job.city}\nNew time: ${formatPreferredTime(newDate.toISOString())}`);
      return;
    }

    // Create a new calendar event for the rescheduled time
    const newEventId = await createJobEvent(job, newDate);
    console.log(`[Reschedule] Created new calendar event ${newEventId}`);

    const displayTime = formatPreferredTime(newDate.toISOString());

    // Update job with new time — clear rescheduling_new_time, re-arm for tech reply
    await updateJob(job.id, {
      status: 'awaiting_tech_reply',
      preferred_time: newDate.toISOString(),
      scheduled_time: newDate.toISOString(),
      calendar_event_id: newEventId,
      rescheduling_new_time: null,
      current_tech_id: techId,
      current_tech_name: tech.name,
      tech_notified_at: new Date().toISOString(),
    });
    console.log(`[Reschedule] Job ${job.id} updated → awaiting_tech_reply for ${displayTime}`);

    await sendSMS(tech.phone, `Hey ${tech.name.split(' ')[0]}, the customer for the ${job.city} job wants to move to ${displayTime} — still good for you? Reply Yes or No.`);
    await sendSMS(job.customer_phone, `Got it! Let me confirm the new time with our tech and I'll get back to you shortly.`);
    console.log(`[Reschedule] _proceedWithRescheduleTime DONE — job ${job.id} re-asked tech ${tech.name} for ${displayTime}`);
  } catch (err) {
    console.error(`[Reschedule] _proceedWithRescheduleTime ERROR for job ${job.id}:`, err.message, err.stack);
    await sendSMS(OWNER_PHONE, `RESCHEDULE ERROR\nJob ${job.id} — ${job.customer_name}\n${err.message}`).catch(() => {});
  }
}

async function handleRescheduleReply(job, techId, reply) {
  const normalized = reply.trim().toLowerCase();
  const newDate = new Date(job.rescheduling_new_time);
  const displayTime = formatPreferredTime(job.rescheduling_new_time);
  const firstName = job.customer_name.split(' ')[0];

  if (normalized === 'yes' || normalized === 'y') {
    // Delete old calendar event, create new one
    if (job.calendar_event_id) await deleteJobEvent(job.calendar_event_id).catch(() => {});
    const newEventId = await createJobEvent(job, newDate);
    // Use confirmed_tech_name if available, otherwise look up the tech by id
    const techName = job.confirmed_tech_name || (() => {
      const { data: t } = supabase.from('technicians').select('name').eq('id', techId).single();
      return t ? t.name : null;
    })();
    await confirmJobEvent(newEventId, techName);
    await updateJob(job.id, {
      status: 'confirmed',
      confirmed_tech_id: techId,
      preferred_time: job.rescheduling_new_time,
      scheduled_time: newDate.toISOString(),
      calendar_event_id: newEventId,
      rescheduling_new_time: null,
    });
    await sendSMS(job.customer_phone, `You're all set, ${firstName} — rescheduled to ${displayTime}!`);
    console.log(`[Orchestrator] Job ${job.id} rescheduled to ${newDate.toISOString()}`);
  } else {
    // Tech can't do the new time — try next tech with the new scheduled time
    await updateJob(job.id, {
      status: 'tech_search',
      scheduled_time: newDate.toISOString(),
      preferred_time: job.rescheduling_new_time,
      rescheduling_new_time: null,
      tech_search_index: (job.tech_search_index || 0) + 1,
    });
    // Override no-tech message so it makes sense for a reschedule context
    const { data: refreshedJob } = await supabase.from('jobs').select('*').eq('id', job.id).single();
    const { data: techs } = await supabase.from('technicians').select('*').eq('active', true).order('priority', { ascending: true });
    if ((refreshedJob.tech_search_index || 0) >= techs.length) {
      await updateJob(job.id, { status: 'confirmed', preferred_time: job.preferred_time, scheduled_time: job.scheduled_time, rescheduling_new_time: null });
      await sendSMS(job.customer_phone, `Sorry, none of our techs are available for that time — would you like to try a different day or time?`);
      return;
    }
    await dispatchToNextTech(job.id);
  }
}

module.exports = { processNewJob, handleTechReply, handleJobCompletion, handlePaymentComplete, handleTechPhotos, checkPaymentReminder, cancelJob, dispatchToNextTech, buildSupplyList, calculateBasePayout, handleRescheduleRequest, handleRescheduleConfirmDay, handleRescheduleReply, handleLateCancellation, handleTechCancelRequest, handleTechCancelConfirm, handleTechRescheduleRequest, handleTechRescheduleTime, handleTechRescheduleCustReply, handleTechRescheduleDayConfirm, handleTechRescheduleImpliedDayConfirm, handleTechRescheduleReconfirm, handleTechConfirmedMessage };
