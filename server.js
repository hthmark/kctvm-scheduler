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

// Stripe webhook needs raw body BEFORE express.json() parses it
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/webhook', require('./route-webhook'));
app.use('/sms', require('./route-sms'));
app.use('/stripe', require('./route-stripe'));
app.use('/jobs', require('./route-jobs'));

app.get('/', (req, res) => res.json({ status: 'KCTVM Scheduler running' }));

app.get('/payment-success', (req, res) => {
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>✅ Payment received!</h1><p>Your TV mounting appointment is confirmed. You\'ll receive a text shortly with your booking details.</p></body></html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
