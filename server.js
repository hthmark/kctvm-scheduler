require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

// Stripe webhook MUST come before express.json() — needs raw body
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), require('./route-stripe').webhookHandler);

// All other routes use parsed JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static('public'));

app.use('/webhook', require('./route-webhook'));
app.use('/sms', require('./route-sms'));
app.use('/jobs', require('./route-jobs'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/admin/send-sms', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message are required' });
  const { sendSMS } = require('./service-sms');
  const result = await sendSMS(to, message);
  if (result.success === false && !result.blocked) return res.status(500).json({ error: result.error || 'Send failed' });
  res.json({ ok: true });
});

console.log('[Server] All routes loaded successfully');

const { checkTechTimeouts } = require('./service-orchestrator');
setInterval(() => checkTechTimeouts().catch(err => console.error('[TechTimeout] Poll error:', err.message)), 60 * 1000);

app.get('/', (req, res) => res.json({ status: 'KCTVM Scheduler running' }));
app.get('/payment-success', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>✅ Payment received!</h1><p>Your TV mounting appointment is confirmed. You\'ll receive a text shortly.</p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
