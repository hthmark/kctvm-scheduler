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
      const addressField = session.custom_fields?.find(f => f.key === 'installation_address');
      const address = addressField?.text?.value || null;
      console.log(`[Stripe] Address collected: ${address}`);
      if (address) {
        await supabase.from('jobs').update({ customer_address: address }).eq('id', jobId);
      }
      const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
      if (job && job.status === 'awaiting_payment') {
        await handlePaymentComplete(job, address).catch(err =>
          console.error('[Stripe] handlePaymentComplete error:', err)
        );
      }
    }
  }
}

module.exports = { webhookHandler };
