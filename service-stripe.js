const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

async function createPaymentLink(job) {
  const product = await stripe.products.create({
    name: `TV Mounting — ${job.num_tvs} TV${job.num_tvs > 1 ? 's' : ''} in ${job.city}`,
  });

  const price = await stripe.prices.create({
    currency: 'usd',
    unit_amount: Math.round(job.total_price * 100),
    product: product.id,
  });

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { job_id: job.id },
    after_completion: {
      type: 'redirect',
      redirect: { url: `${process.env.BASE_URL}/payment-success?job_id=${job.id}` },
    },
    custom_fields: [
      {
        key: 'full_address',
        label: { type: 'custom', custom: 'Full installation address' },
        type: 'text',
        optional: false,
      },
    ],
  });

  console.log(`[Stripe] Payment link created for job ${job.id}: ${paymentLink.url}`);
  return paymentLink.url;
}

async function checkPaymentStatus(jobId) {
  const sessions = await stripe.checkout.sessions.list({ limit: 10 });
  for (const session of sessions.data) {
    if (session.metadata?.job_id === jobId && session.payment_status === 'paid') {
      const address = session.custom_fields?.find(f => f.key === 'full_address')?.text?.value || null;
      return { paid: true, address, sessionId: session.id };
    }
  }
  return { paid: false, address: null, sessionId: null };
}

function verifyWebhookSignature(payload, signature) {
  return stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { createPaymentLink, checkPaymentStatus, verifyWebhookSignature };
