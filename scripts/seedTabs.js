require('dotenv').config();
const { db } = require('../src/config/firebase');

async function main() {
  const snap = await db.ref('tabs').once('value');
  const existing = snap.val() || {};
  const updates = {};
  if (!existing.indo) {
    updates['tabs/indo'] = { name: 'Nokos Indo', emoji: '🇮🇩', order: 0, created_at: Date.now() };
  }
  if (!existing.luar) {
    updates['tabs/luar'] = { name: 'Nokos Luar', emoji: '🌍', order: 1, created_at: Date.now() };
  }
  if (Object.keys(updates).length > 0) {
    await db.ref('/').update(updates);
    console.log('Seeded:', Object.keys(updates).join(', '));
  } else {
    console.log('Tabs already exist, skip.');
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
