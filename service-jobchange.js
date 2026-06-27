'use strict';

/**
 * Job Change Service
 * Handles mid-flow job modifications:
 * - Adding TVs or wire concealment after booking
 * - Rescheduling before or after tech confirms
 * - Removing services (routes to Gabe)
 */

const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('./service-sms');
const { createPaymentLink } = require('./service-stripe');
const { shouldAlertOwner } = require('./service-ratelimit');
const { attemptDateParse, isTimeAvailable, createJobEvent, deleteJobEvent } = require('./service-calendar');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const OWNER_PHONE = process.env.OWNER_PHONE || '+13862287246';

async function updateJob(jobId, updates) {
  const { error } = await supabase.from('jobs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) throw new Error('DB update failed: ' + error.message);
}

// ─── PRICING ──────────────────────────────────────────────────────────────────
function calcAddonPrice(addons) {
  var price = 0;
  if (addons.tvs) {
    addons.tvs.forEach(function(tv) {
      price += tv.size === 'large' ? 80 : 70;
      if (tv.mount === 'fixed') price += 60;
      if (tv.mount === 'articulating') price += 120;
      if (tv.wall === 'brick') price += 150;
      if (tv.wire === 'cable') price += 150;
    });
  }
  if (addons.wireConceals) {
    price += addons.wireConceals * 150;
  }
  return price;
}

function calcTechAddonPayout(addons) {
  var payout = 0;
  if (addons.tvs) {
    addons.tvs.forEach(function(tv) {
      payout += 40;
      if (tv.wire === 'cable') payout += 40;
    });
  }
  if (addons.wireConceals) {
    payout += addons.wireConceals * 40;
  }
  return payout;
}

// ─── ADD TV OR WIRE CONCEAL ───────────────────────────────────────────────────
async function handleAddOn(jobId, customerPhone, addons) {
  const tvCount = (addons.tvs || []).length;
  console.log('[JobChange] Processing addon for job ' + jobId + ' — ' + tvCount + ' TV(s)');
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  const { data: tech } = job.confirmed_tech_id
    ? await supabase.from('technicians').select('*').eq('id', job.confirmed_tech_id).single()
    : { data: null };

  const addonPrice = calcAddonPrice(addons);
  const addonPayout = calcTechAddonPayout(addons);

  // Update job totals in Supabase
  const newTotal = (parseFloat(job.total_price) || 0) + addonPrice;
  const newBasePayout = (parseFloat(job.base_payout) || 0) + addonPayout;

  // Add new TV fields to job
  const tvUpdates = {};
  if (addons.tvs) {
    const existingTvCount = job.num_tvs || 1;
    addons.tvs.forEach(function(tv, i) {
      const tvNum = existingTvCount + i + 1;
      tvUpdates['tv_' + tvNum + '_size'] = tv.size;
      tvUpdates['tv_' + tvNum + '_inches'] = tv.inches || (tv.size === 'large' ? 75 : 52);
      tvUpdates['tv_' + tvNum + '_mount'] = tv.mount;
      tvUpdates['tv_' + tvNum + '_wall'] = tv.wall;
      tvUpdates['tv_' + tvNum + '_wire'] = tv.wire;
    });
    tvUpdates.num_tvs = existingTvCount + addons.tvs.length;
  }

  await updateJob(jobId, {
    total_price: newTotal,
    base_payout: newBasePayout,
    ...tvUpdates
  });

  // Create new Stripe payment link for the full new total
  let paymentUrl = null;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Deactivate the original payment link if we have its ID
    if (job.stripe_payment_link_id) {
      await stripe.paymentLinks.update(job.stripe_payment_link_id, { active: false }).catch(function(err) {
        console.warn('[JobChange] Could not deactivate original payment link:', err.message);
      });
    }

    const stripePrice = await stripe.prices.create({
      currency: 'usd',
      unit_amount: Math.round(newTotal * 100),
      product_data: {
        name: 'TV Mounting — ' + job.city + ' (updated total)'
      }
    });
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: stripePrice.id, quantity: 1 }],
      metadata: { job_id: jobId, updated: 'true' }
    });
    paymentUrl = link.url;

    // Store the new link on the job
    await updateJob(jobId, { stripe_payment_link: paymentUrl });
  } catch (err) {
    console.error('[JobChange] Stripe addon error:', err.message);
  }

  // Text customer with updated full-total payment link
  await sendSMS(customerPhone,
    'We\'ve updated your booking to include the additional TV — please use this new payment link for the full amount and disregard the previous one: ' + (paymentUrl || 'link coming shortly')
  );

  // Text tech with updated job details
  if (tech) {
    let updateMsg = 'Hey ' + tech.name.split(' ')[0] + ', update on the ' + job.city + ' job —';
    if (addons.tvs) {
      addons.tvs.forEach(function(tv) {
        updateMsg += ' customer added a ' + (tv.inches || (tv.size === 'large' ? '65"+ ' : 'under 65" ')) + 'TV on ' + tv.wall + ' with ' + tv.mount + ' mount' + (tv.wire === 'cable' ? ' and wire concealment' : '') + '.';
      });
    }
    if (addons.wireConceals) {
      updateMsg += ' Customer added wire concealment for ' + addons.wireConceals + ' TV(s).';
    }
    updateMsg += ' New total payout: $' + newBasePayout + '. Thanks!';
    await sendSMS(tech.phone, updateMsg);
  }

  console.log('[JobChange] Add-on processed for job ' + jobId + ' — $' + addonPrice + ' added');
  return { success: true, addonPrice, paymentUrl };
}

// ─── RESCHEDULE ───────────────────────────────────────────────────────────────
async function handleReschedule(jobId, customerPhone, newTimeText) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();

  const newTime = attemptDateParse(newTimeText);
  if (!newTime) {
    await sendSMS(customerPhone, 'Let me check that for you!');
    if (shouldAlertOwner('reschedule_parse:' + customerPhone)) {
      await sendSMS(OWNER_PHONE, '📱 RESCHEDULE NEEDED — couldn\'t parse time\nCustomer: ' + job.customer_name + '\nPhone: ' + customerPhone + '\nRequested: "' + newTimeText + '"');
    }
    return { success: false };
  }

  const available = await isTimeAvailable(newTime).catch(() => false);
  if (!available) {
    await sendSMS(customerPhone, 'Unfortunately that time is already booked — do you have another time that works?');
    return { success: false, conflict: true };
  }

  // Update calendar
  if (job.calendar_event_id) {
    await deleteJobEvent(job.calendar_event_id).catch(() => {});
  }
  const newEventId = await createJobEvent(job, newTime);

  const formattedTime = newTime.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });

  await updateJob(jobId, {
    preferred_time: newTimeText,
    scheduled_time: newTime.toISOString(),
    calendar_event_id: newEventId
  });

  // Re-ask tech (same tech, whether awaiting reply or already confirmed)
  const techId = job.confirmed_tech_id || job.current_tech_id;
  if (techId) {
    const { data: tech } = await supabase.from('technicians').select('*').eq('id', techId).single();
    if (tech) {
      await sendSMS(tech.phone,
        'Hey ' + tech.name.split(' ')[0] + ', customer just asked to reschedule — does ' + formattedTime + ' work for you? Reply "Yes" if available or "No" if not.'
      );
      // Reset status to awaiting tech reply
      await updateJob(jobId, { status: 'awaiting_tech_reply' });
      console.log('[JobChange] Reschedule sent to tech ' + tech.name + ' for ' + formattedTime);
    }
  }

  // Confirm with customer
  await sendSMS(customerPhone,
    'Got it! Let me confirm the new time with our tech and I\'ll get back to you shortly.'
  );

  return { success: true, formattedTime };
}

// ─── REMOVE SERVICE (route to Gabe) ──────────────────────────────────────────
async function handleRemoval(jobId, customerPhone, removalDetails, originalPrice, newPrice) {
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();

  // Tell customer we'll handle the refund
  await sendSMS(customerPhone,
    'No problem! We\'ll go ahead and refund that from the invoice — so the new total will be $' + newPrice + ' vs the original $' + originalPrice + '. Give us just a moment to process that.'
  );

  // Alert Gabe to handle the refund
  if (shouldAlertOwner('removal:' + customerPhone)) {
    await sendSMS(OWNER_PHONE,
      '📱 REMOVAL/REFUND NEEDED\nCustomer: ' + job.customer_name + '\nPhone: ' + customerPhone + '\nJob: ' + job.preferred_time + ' in ' + job.city + '\nRemoval: ' + removalDetails + '\nOriginal: $' + originalPrice + ' → New: $' + newPrice
    );
  }

  return { success: true };
}

module.exports = { handleAddOn, handleReschedule, handleRemoval, calcAddonPrice };
