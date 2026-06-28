const { createClient } = require('@supabase/supabase-js');
const { verifyWebhookSignature } = require('./service-stripe');
const { handlePaymentComplete } = require('./service-orchestrator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function webhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = verifyWebhookSignature(req.body, sig);
  } catch (err) {
    console.error('[Stripe] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      const jobId = session.metadata?.job_id;
      if (!jobId) return;
      const shippingAddr = session.shipping_details?.address || session.customer_details?.address || null;
      const addressStr = shippingAddr
        ? [shippingAddr.line1, shippingAddr.line2, shippingAddr.city, shippingAddr.state, shippingAddr.postal_code].filter(Boolean).join(', ')
        : null;
      console.log(`[Stripe] Address collected: ${addressStr}`);
      if (addressStr) {
        await supabase.from('jobs').update({ customer_address: addressStr }).eq('id', jobId);
      }
      const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
      if (job && job.status === 'awaiting_payment') {
        await handlePaymentComplete(job, addressStr).catch(err =>
          console.error('[Stripe] handlePaymentComplete error:', err)
        );
      }
    }
  }
}

module.exports = { webhookHandler };
