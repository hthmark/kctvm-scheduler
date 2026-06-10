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

app.use('/webhook', require('./route-webhook'));
app.use('/sms', require('./route-sms'));
app.use('/jobs', require('./route-jobs'));

console.log('[Server] All routes loaded successfully');

app.get('/', (req, res) => res.json({ status: 'KCTVM Scheduler running' }));
app.get('/payment-success', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>✅ Payment received!</h1><p>Your TV mounting appointment is confirmed. You\'ll receive a text shortly.</p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
