const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { isTimeAvailable, createJobEvent, confirmJobEvent, deleteJobEvent, attemptDateParse } = require('./service-calendar');
const { generateTechMessage } = require('./service-claude');
const { createPaymentLink, checkPaymentStatus } = require('./service-stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TECH_TIMEOUT_MS = (parseInt(process.env.TECH_REPLY_TIMEOUT_MINUTES) || 30) * 60 * 1000;

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
  await sendSMS(tech.phone, `Great, you're confirmed for the job in ${job.city} at ${job.preferred_time}! We'll send you the full address once the customer pays. Thanks ${tech.name.split(' ')[0]}!`);
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
  const tvDetails = [];
  for (let i = 1; i <= 10; i++) {
    const size = job[`tv_${i}_size`];
    if (!size || size === 'null') continue;
    tvDetails.push(`TV${i}: ${size}, mount=${job[`tv_${i}_mount`]}, wall=${job[`tv_${i}_wall`]}, wire=${job[`tv_${i}_wire`]}`);
  }
  await sendSMS(tech.phone, `Job confirmed & paid!\n${job.customer_name} — ${address}\nTime: ${job.preferred_time}\n${tvDetails.join('\n')}\nPlease send photos upon completion + any supply receipts. Thanks ${tech.name.split(' ')[0]}!`);
  await sendSMS(job.customer_phone, `You're all set, ${job.customer_name.split(' ')[0]}! Payment received. ${tech.name.split(' ')[0]} will be there at ${job.preferred_time}. See you then!`);
}

async function handleJobCompletion(jobId) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  await updateJob(jobId, { status: 'completed', completed_at: new Date().toISOString() });
  await sendSMS(job.customer_phone, `Thank you for choosing Kansas City TV Mounting, ${job.customer_name.split(' ')[0]}! We'd love a Google review if you have a moment: https://g.page/r/YOUR_GOOGLE_REVIEW_LINK/review`);
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
