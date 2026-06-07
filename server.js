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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/webhook', require('./route-webhook'));
app.use('/sms', require('./route-sms'));
app.use('/stripe', require('./route-stripe'));
app.use('/jobs', require('./route-jobs'));

app.get('/', (req, res) => res.json({ status: 'KCTVM Scheduler running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
