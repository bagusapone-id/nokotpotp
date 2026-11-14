require('dotenv').config();
const express = require('express');
const path = require('path');

require('./src/config/firebase');

const { startExpiryGuardian, runGuardianTick } = require('./src/services/expiryGuardian');
const purchaseRoutes = require('./src/routes/purchaseRoutes');
const orderRoutes = require('./src/routes/orderRoutes');
const cancelRoutes = require('./src/routes/cancelRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const registerRoutes = require('./src/routes/registerRoutes');
const depositRoutes = require('./src/routes/depositRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Cron endpoint — panggil ini setiap menit via Vercel Cron / UptimeRobot
// Vercel Cron: tambahkan ke vercel.json "crons": [{"path":"/api/cron/tick","schedule":"* * * * *"}]
app.get('/api/cron/tick', async (req, res) => {
  try {
    await runGuardianTick();
    return res.status(200).json({ success: true, time: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.use('/api/register', registerRoutes);
app.use('/api/purchase', purchaseRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/orders', cancelRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/deposit', depositRoutes);

app.use((req, res) => {
  if (req.path.startsWith('/admin')) {
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[Server] Panel Nokos WA running on port ${PORT}`);
    startExpiryGuardian();
  });
}
