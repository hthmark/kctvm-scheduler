const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse } = require('./service-calendar');
const { generateTechMessage, analyzeJobPhotos } = require('./service-claude');
const { createPaymentLink, checkPaymentStatus } = require('./service-stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TECH_TIMEOUT_MS = (parseInt(process.env.TECH_REPLY_TIMEOUT_MINUTES) || 30) * 60 * 1000;
const GOOGLE_REVIEW_URL = 'https://g.page/r/CWmvZghawMfzEBM/review';
const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';

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
  console.log(`[Orchestrator] Processing new job ${job.id} for ${job.customer_name}`);
  await updateJob(job.id, { status: 'scheduling' });
  const preferredDate = attemptDateParse(job.preferred_time);
  if (preferredDate && preferredDate > new Date()) {
    const available = await isTimeAvailable(preferredDate);
    if (available) {
      const eventId = await createJobEvent(job, preferredDate);
      await updateJob(job.id, { status: 'tech_search', scheduled_time: preferredDate.toISOString(), calendar_event_id: eventId, tech_search_index: 0 });
      const { outOfRangeTVs } = buildSupplyList(job);
      if (outOfRangeTVs.length > 0) {
        const tvNums = outOfRangeTVs.map(t => `TV${t.tvNum}`).join(', ');
        await updateJob(job.id, { status: 'awaiting_time_confirm' });
        console.log(`[Orchestrator] Job ${job.id} awaiting time confirm — no automated text sent, concierge handles this`);
        return;
      }
      await dispatchToNextTech(job.id);
    } else {
      // Calendar conflict — find next available slot and text customer
      console.log(`[Orchestrator] Conflict at ${job.preferred_time} — finding next available slot`);
      const { findNextAvailableTime } = require('./service-calendar');
      const nextSlot = await findNextAvailableTime(null).catch(() => null);
      const firstName = job.customer_name ? job.customer_name.split(' ')[0] : 'there';
      if (nextSlot) {
        await sendSMS(job.customer_phone,
          `Hey ${firstName}, looks like we're already booked for ${job.preferred_time} unfortunately, but I have ${nextSlot.label} available. Does that work for you?`
        );
        await updateJob(job.id, {
          status: 'awaiting_time_confirm',
          proposed_time: nextSlot.time.toISOString(),
          proposed_time_label: nextSlot.label
        });
        console.log(`[Orchestrator] Proposed ${nextSlot.label} to customer for job ${job.id}`);
      } else {
        await sendSMS(job.customer_phone,
          `Hey ${firstName}, the time you requested isn't available unfortunately. What other day and time works for you?`
        );
        await updateJob(job.id, { status: 'awaiting_time_confirm' });
      }
    }
  } else {
    await updateJob(job.id, { status: 'awaiting_time_confirm' });
    console.log(`[Orchestrator] Job ${job.id} awaiting time confirm — no automated text sent, concierge handles this`);
    // Schedule follow-up if no response in 3 hours
    setTimeout(() => sendFollowUp(job.id), 3 * 60 * 60 * 1000);
  }
}

async function handleCustomerTimeReply(job, timeText) {
  const msgLower = timeText.toLowerCase().trim();

  // Handle yes/no reply to a proposed time
  const isYes = ['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay', 'works', 'perfect', 'sounds good', 'that works', "that'll work", 'great'].some(w => msgLower === w || msgLower.startsWith(w + ' ') || msgLower.endsWith(' ' + w));
  const isNo = ['no', 'n', 'nope', 'doesnt work', "doesn't work", 'cant', "can't", 'not available', 'no good'].some(w => msgLower === w || msgLower.includes(w));

  if (job.proposed_time && isYes && !isNo) {
    // Customer accepted the proposed slot
    const proposedDate = new Date(job.proposed_time);
    const available = await isTimeAvailable(proposedDate);
    if (available) {
      const eventId = await createJobEvent(job, proposedDate);
      await updateJob(job.id, {
        status: 'tech_search',
        scheduled_time: proposedDate.toISOString(),
        preferred_time: job.proposed_time_label || job.proposed_time,
        calendar_event_id: eventId,
        tech_search_index: 0,
        proposed_time: null,
        proposed_time_label: null
      });
      await sendSMS(job.customer_phone, `Perfect! Let me get a tech confirmed for you and I'll send over a payment link shortly.`);
      await dispatchToNextTech(job.id);
      return;
    } else {
      // Slot got taken in the meantime — find another
      const { findNextAvailableTime } = require('./service-calendar');
      const nextSlot = await findNextAvailableTime(null).catch(() => null);
      if (nextSlot) {
        await sendSMS(job.customer_phone, `Ah sorry, that slot just got taken! How about ${nextSlot.label} instead?`);
        await updateJob(job.id, { proposed_time: nextSlot.time.toISOString(), proposed_time_label: nextSlot.label });
      } else {
        await sendSMS(job.customer_phone, `Sorry about that — what day and time works best for you?`);
        await updateJob(job.id, { proposed_time: null, proposed_time_label: null });
      }
      return;
    }
  }

  if (job.proposed_time && isNo) {
    // Customer declined the proposed slot — ask for their preference
    await sendSMS(job.customer_phone, `No worries! What day and time works best for you?`);
    await updateJob(job.id, { proposed_time: null, proposed_time_label: null });
    return;
  }

  // Customer sent a specific time
  const parsedDate = attemptDateParse(timeText);
  if (!parsedDate) {
    const withToday = timeText.match(/^\d{1,2}(:\d{2})?\s*(am|pm)$/i) ? timeText + ' today' : null;
    const retried = withToday ? attemptDateParse(withToday) : null;
    if (retried) {
      return handleCustomerTimeReply(job, withToday);
    }
    console.log(`[Orchestrator] Could not parse time "${timeText}" for job ${job.id} — concierge handles`);
    return;
  }
  const available = await isTimeAvailable(parsedDate);
  if (available) {
    const eventId = await createJobEvent(job, parsedDate);
    await updateJob(job.id, { status: 'tech_search', scheduled_time: parsedDate.toISOString(), preferred_time: timeText, calendar_event_id: eventId, tech_search_index: 0, proposed_time: null, proposed_time_label: null });
    await sendSMS(job.customer_phone, `Got it, ${timeText} — let me check availability and get you confirmed!`);
    await dispatchToNextTech(job.id);
  } else {
    await sendSMS(job.customer_phone, `Sorry, ${timeText} is already booked. Do you have another time that works?`);
  }
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
    await techAccepted(job, techId);
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
  const confirmedDate = job.scheduled_time ? new Date(job.scheduled_time).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric' }) : '';
  await sendSMS(tech.phone, `Great, you're confirmed for the job in ${job.city} at ${job.preferred_time}${confirmedDate ? ' (' + confirmedDate + ')' : ''}! We'll send you the full address and supply list once the customer pays. Thanks ${tech.name.split(' ')[0]}!`);
  const jobDate = job.scheduled_time ? new Date(job.scheduled_time).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', year: 'numeric' }) : '';
  await sendSMS(job.customer_phone, `Great news, ${job.customer_name.split(' ')[0]}! Your TV mounting is confirmed for ${job.preferred_time}${jobDate ? ' (' + jobDate + ')' : ''} with ${tech.name.split(' ')[0]}. Please complete payment and provide your full installation address here: ${paymentUrl}`);
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

  const basePayout = calculateBasePayout(job);
  await updateJob(job.id, { base_payout: basePayout });

  const techMsg = `Job confirmed & paid!\n${job.customer_name} — ${address}\nTime: ${job.preferred_time}\n\n${tvLines.join('\n')}${supplySection}\n\nBase payout: $${basePayout}\nSend photos + receipts via MMS and reply "Done" when finished. Thanks ${tech.name.split(' ')[0]}!`;
  console.log(`[Orchestrator] Tech msg length: ${techMsg.length} chars | body: ${techMsg}`);
  if (techMsg.length > 1580) {
    const part1 = `Job confirmed & paid!\n${job.customer_name} — ${address}\nTime: ${job.preferred_time}\n\n${tvLines.join('\n')}\n\nBase payout: $${basePayout}`;
    const part2 = supplySection.trim() + `\n\nSend photos + receipts via MMS and reply "Done" when finished. Thanks ${tech.name.split(' ')[0]}!`;
    await sendSMS(tech.phone, part1);
    await sendSMS(tech.phone, part2);
  } else {
    await sendSMS(tech.phone, techMsg);
  }
  await sendSMS(job.customer_phone, `You're all set, ${job.customer_name.split(' ')[0]}! Payment received. ${tech.name.split(' ')[0]} will be there at ${job.preferred_time}. See you then!`);
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
    if (tech) await sendSMS(tech.phone, `Hi ${tech.name.split(' ')[0]}, the ${job.city} job on ${job.preferred_time} has been cancelled. Sorry for the inconvenience!`);
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

module.exports = { processNewJob, handleCustomerTimeReply, handleTechReply, handleJobCompletion, handlePaymentComplete, handleTechPhotos, checkPaymentReminder, cancelJob, dispatchToNextTech, buildSupplyList, calculateBasePayout };
