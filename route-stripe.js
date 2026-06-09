const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { verifyWebhookSignature } = require('./service-stripe');
const { handlePaymentComplete } = require('./service-orchestrator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

router.post('/webhook', async (req, res) => {
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
      const address = session.custom_fields?.find(f => f.key === 'full_address')?.text?.value || null;
      const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
      if (job && job.status === 'awaiting_payment') {
        await handlePaymentComplete(job, address).catch(err =>
          console.error('[Stripe] handlePaymentComplete error:', err)
        );
      }
    }
  }
});

module.exports = router;
