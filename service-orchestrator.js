const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse } = require('./service-calendar');
const { generateTechMessage } = require('./service-claude');
const { createPaymentLink, checkPaymentStatus } = require('./service-stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TECH_TIMEOUT_MS = (parseInt(process.env.TECH_REPLY_TIMEOUT_MINUTES) || 30) * 60 * 1000;
const GOOGLE_REVIEW_URL = 'https://g.page/r/CWmvZghawMfzEBM/review';

// ─── WALMART MOUNT LINKS ──────────────────────────────────────────────────────
const MOUNT_LINKS = {
  fixed: {
    small: {
      label: 'ONN Fixed Mount 32"-86"',
      url: 'https://www.walmart.com/ip/777842123'
    },
    large: {
      label: 'ONN Fixed Mount 80"-110"',
      url: 'https://www.walmart.com/ip/ONNFIXED-MNT-80-110/13343901384'
    }
  },
  articulating: {
    small_low: {
      label: 'ONN Full Motion Mount 32"-47"',
      url: 'https://www.walmart.com/ip/onn-Full-Motion-TV-Wall-Mount-for-TVs-32-to-47/593012224'
    },
    small_high: {
      label: 'ONN Full Motion Mount 47"-70"',
      url: 'https://www.walmart.com/ip/onn-Full-Motion-TV-Wall-Mount-for-47-to-70-TVs-Black/384156891'
    },
    large: {
      label: 'ONN Full Motion Mount 50"-86"',
      url: 'https://www.walmart.com/ip/onn-Full-Motion-TV-Wall-Mount-for-50-to-86-TVs-up-to-15-Tilting/866844895'
    }
  }
};

// ─── HOME DEPOT WIRE CONCEAL LINKS ───────────────────────────────────────────
const WIRE_CONCEAL_LINKS = [
  { label: 'Brush Plate (1 per TV)', url: 'https://www.homedepot.com/p/Commercial-Electric-1-Gang-Brush-Plastic-Wall-Plate-White-5038-WH/207161871' },
  { label: 'Single Gang Box (1 per TV)', url: 'https://www.homedepot.com/p/Carlon-1-Gang-Non-Metallic-Low-Voltage-Old-Work-Bracket-SC100RR-SC100RR/100160916' }
];

/**
 * Determine the correct mount link for a TV
 * Returns { label, url } or null if mount not needed or out of range
 */
function getMountInfo(mountType, tvSize, tvInches) {
  if (mountType === 'yes' || mountType === 'no' || !mountType) return null;
  const inches = tvInches || (tvSize === 'large' ? 70 : 52);

  if (mountType === 'fixed') {
    // Fixed: under 80" use 32-86 mount, 80"+ use 80-110 mount
    if (inches >= 80) return MOUNT_LINKS.fixed.large;
    if (inches <= 86) return MOUNT_LINKS.fixed.small;
    return null; // out of range
  }

  if (mountType === 'articulating') {
    if (inches <= 47) return MOUNT_LINKS.articulating.small_low;   // 32"-47"
    if (inches <= 70) return MOUNT_LINKS.articulating.small_high;  // 47"-70"
    if (inches <= 86) return MOUNT_LINKS.articulating.large;       // 70"-86"
    return null; // out of range — 87"+ needs custom
  }

  return null;
}

/**
 * Build full supply list for a job — mounts, wire concealment, brick notes
 * Returns { mountItems, wireItems, brickTVs, outOfRangeTVs }
 */
function buildSupplyList(job) {
  const mountItems = [];
  const wireItems = [];
  const brickTVs = [];
  const outOfRangeTVs = [];

  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null' || size === 'undefined') continue;

    const mount = job[`tv_${i}_mount`];
    const wall = job[`tv_${i}_wall`];
    const wire = job[`tv_${i}_wire`];

    // Mount needed
    if (mount === 'fixed' || mount === 'articulating') {
      const mountInfo = getMountInfo(mount, size, job[`tv_${i}_inches`]);
      if (mountInfo) {
        mountItems.push({ tvNum: i, type: mount, size, ...mountInfo });
      } else {
        outOfRangeTVs.push({ tvNum: i, mount, size });
      }
    }

    // Wire concealment needed
    if (wire === 'cable') {
      wireItems.push({ tvNum: i });
    }

    // Brick wall
    if (wall === 'brick') {
      brickTVs.push({ tvNum: i });
    }
  }

  return { mountItems, wireItems, brickTVs, outOfRangeTVs };
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

      // Check for out-of-range TVs before dispatching
      const { outOfRangeTVs } = buildSupplyList(job);
      if (outOfRangeTVs.length > 0) {
        const tvNums = outOfRangeTVs.map(t => `TV${t.tvNum}`).join(', ');
        await sendSMS(job.customer_phone, `Hi ${job.customer_name.split(' ')[0]}! This is Kansas City TV Mounting. For ${tvNums}, we'll need to order a custom mount online which takes about 2 days. Would it work to push your appointment back 2 days to ${job.preferred_time} + 2 days? Just reply Yes to confirm or suggest another time.`);
        await updateJob(job.id, { status: 'awaiting_time_confirm' });
        return;
      }

      await dispatchToNextTech(job.id);
    } else {
      await updateJob(job.id, { status: 'scheduling_conflict' });
      await sendSMS(job.customer_phone, `Hi ${job.customer_name.split(' ')[0]}! This is Kansas City TV Mounting. Unfortunately your preferred time of ${job.preferred_time} isn't available. What other times work for you?`);
    }
  } else {
    await updateJob(job.id, { status: 'awaiting_time_confirm' });
    await sendSMS(job.customer_phone, `Hi ${job.customer_name.split(' ')[0]}! This is Kansas City TV Mounting. Thanks for your quote request! What specific date and time works best? (Example: "Saturday June 14 at 2pm")`);
  }
}

async function handleCustomerTimeReply(job, timeText) {
  const parsedDate = attemptDateParse(timeText);
  if (!parsedDate) {
    await sendSMS(job.customer_phone, `Thanks! Could you try a format like "Saturday June 14 at 2pm"?`);
    return;
  }
  const available = await isTimeAvailable(parsedDate);
  if (available) {
    const eventId = await createJobEvent(job, parsedDate);
    await updateJob(job.id, { status: 'tech_search', scheduled_time: parsedDate.toISOString(), preferred_time: timeText, calendar_event_id: eventId, tech_search_index: 0 });
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
  await sendSMS(tech.phone, `Great, you're confirmed for the job in ${job.city} at ${job.preferred_time}! We'll send you the full address and supply list once the customer pays. Thanks ${tech.name.split(' ')[0]}!`);
  await sendSMS(job.customer_phone, `Great news, ${job.customer_name.split(' ')[0]}! Your TV mounting is confirmed for ${job.preferred_time} with ${tech.name.split(' ')[0]}. Please complete payment and provide your full installation address here: ${paymentUrl}`);
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

  // Build human-readable TV summary
  const tvLines = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null') continue;
    const sizeLabel = size === 'small' ? 'under 65"' : '65" or larger';
    const mount = job[`tv_${i}_mount`];
    const mountLabel = mount === 'yes' ? 'has mount' : mount === 'fixed' ? 'fixed mount needed' : mount === 'articulating' ? 'articulating mount needed' : mount;
    const wallLabel = job[`tv_${i}_wall`] === 'brick' ? 'BRICK WALL' : 'drywall';
    const wireLabel = job[`tv_${i}_wire`] === 'cable' ? 'wire concealment' : 'no wire concealment';
    tvLines.push(`TV${i}: ${sizeLabel}, ${mountLabel}, ${wallLabel}, ${wireLabel}`);
  }

  // Build supply section
  let supplySection = '';

  if (mountItems.length > 0) {
    supplySection += `\n\n🛒 PICK UP MOUNTS FROM WALMART:`;
    mountItems.forEach(m => {
      supplySection += `\nTV${m.tvNum} — ${m.label}: ${m.url}`;
    });
  }

  if (wireItems.length > 0) {
    supplySection += `\n\n🛒 PICK UP WIRE CONCEAL SUPPLIES (${wireItems.length}x each) FROM HOME DEPOT:`;
    WIRE_CONCEAL_LINKS.forEach(item => {
      supplySection += `\n${item.label}: ${item.url}`;
    });
  }

  if (brickTVs.length > 0) {
    const brickNums = brickTVs.map(t => `TV${t.tvNum}`).join(', ');
    supplySection += `\n\n🧱 BRICK WALL — ${brickNums}: Bring masonry drill bits and appropriate anchors!`;
  }

  const techMsg = `Job confirmed & paid!\n${job.customer_name} — ${address}\nTime: ${job.preferred_time}\n\n${tvLines.join('\n')}${supplySection}\n\nSend photos + receipts and reply "Done" when finished. Thanks ${tech.name.split(' ')[0]}!`;

  await sendSMS(tech.phone, techMsg);
  await sendSMS(job.customer_phone, `You're all set, ${job.customer_name.split(' ')[0]}! Payment received. ${tech.name.split(' ')[0]} will be there at ${job.preferred_time}. See you then!`);
  console.log(`[Orchestrator] Job ${job.id} confirmed — tech and customer notified`);
}

async function handleJobCompletion(jobId) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  await updateJob(jobId, { status: 'completed', completed_at: new Date().toISOString() });
  await sendSMS(job.customer_phone, `Thank you for choosing Kansas City TV Mounting, ${job.customer_name.split(' ')[0]}! We hope everything looks great. We'd love a quick Google review if you have a moment: ${GOOGLE_REVIEW_URL}`);
  console.log(`[Orchestrator] Job ${jobId} completed — review request sent to customer`);
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

module.exports = { processNewJob, handleCustomerTimeReply, handleTechReply, handleJobCompletion, handlePaymentComplete, checkPaymentReminder, cancelJob, dispatchToNextTech };
