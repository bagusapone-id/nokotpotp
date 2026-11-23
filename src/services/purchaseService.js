const { db } = require('../config/firebase');
const { retryTransaction } = require('../utils/retryTransaction');
const { getBalanceBuckets, spendBalance } = require('./balanceService');

class PurchaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function generateOrderId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD-${dateStr}-${rand}`;
}

async function ensureUserRecord(uid, username) {
  const snap = await db.ref(`users/${uid}`).once('value');
  if (!snap.exists()) {
    const cleanUsername = String(username || uid).trim();
    await db.ref(`users/${uid}`).set({
      username: cleanUsername,
      username_lower: String(cleanUsername).trim().toLowerCase(),
      created_at: Date.now(),
      balance: 0,
      withdrawable_balance: 0,
    });
  }
}

async function purchase(uid, username, countryKey) {
  await ensureUserRecord(uid, username);

  // 1. Read country info
  const countrySnap = await db.ref(`countries/${countryKey}`).once('value');
  if (!countrySnap.exists()) {
    throw new PurchaseError('INVALID_COUNTRY', 'Negara tidak ditemukan.');
  }
  const country = countrySnap.val();
  const price = country.price;

  // 2. Pre-check balance
  const balanceSnap = await db.ref(`users/${uid}/balance`).once('value');
  const currentBalance = balanceSnap.val() || 0;
  if (currentBalance < price) {
    throw new PurchaseError(
      'INSUFFICIENT_BALANCE',
      `Saldo tidak mencukupi. Saldo: Rp ${Number(currentBalance).toLocaleString('id-ID')}, Harga: Rp ${Number(price).toLocaleString('id-ID')}.`
    );
  }

  // 3. Cek apakah negara offline (setelah cek saldo)
  if (country.offline === true) {
    const reason = country.offline_reason || 'Stok sedang tidak tersedia sementara.';
    throw new PurchaseError('COUNTRY_OFFLINE', reason);
  }

  // 4. Find one AVAILABLE stock entry
  const stockSnap = await db
    .ref('phone_stocks')
    .orderByChild('country_key')
    .equalTo(countryKey)
    .once('value');

  let availableStockKey = null;
  let availableStockNumber = null;

  if (stockSnap.exists()) {
    stockSnap.forEach((child) => {
      if (child.val().status === 'AVAILABLE' && availableStockKey === null) {
        availableStockKey = child.key;
        availableStockNumber = child.val().number;
      }
    });
  }

  if (!availableStockKey) {
    throw new PurchaseError('OUT_OF_STOCK', 'Stok habis untuk negara ini.');
  }

  const orderId = generateOrderId();
  const createdAt = Date.now();
  const expiresAt = createdAt + 900000; // 15 menit

  // 4. Atomic: deduct balance + lock stock + create order
  await retryTransaction(async () => {
    const userRef = db.ref(`users/${uid}`);
    let spendBreakdown = null;

    const txResult = await userRef.transaction(user => {
      if (user === null) return null;
      if (!user || typeof user !== 'object' || Array.isArray(user)) return;
      if (getBalanceBuckets(user).balance < price) return;
      spendBreakdown = spendBalance(user, price);
      if (!spendBreakdown) return;
      return user;
    });

    if (!txResult.committed) {
      // Re-read actual balance to give accurate error
      const freshSnap = await userRef.once('value');
      const freshBalance = freshSnap.exists()
        ? getBalanceBuckets(freshSnap.val()).balance
        : 0;
      throw new PurchaseError(
        'INSUFFICIENT_BALANCE',
        `Saldo tidak mencukupi. Saldo: Rp ${Number(freshBalance).toLocaleString('id-ID')}, Harga: Rp ${Number(price).toLocaleString('id-ID')}.`
      );
    }
    if (!spendBreakdown) {
      throw new Error(`Could not record balance split for order ${orderId}`);
    }

    // Lock stock
    await db.ref(`phone_stocks/${availableStockKey}/status`).set('LOCKED');

    // Create order
    await db.ref(`orders/${orderId}`).set({
      user_id: uid,
      username: username || uid,
      country_key: countryKey,
      country_name: country.country_name,
      phone_number: availableStockNumber,
      stock_key: availableStockKey,
      status: 'WAITING_OTP',
      otp_code: '',
      resend_count: 0,
      created_at: createdAt,
      expires_at: expiresAt,
      is_refunded: false,
      price: price,
      withdrawable_spent: spendBreakdown.withdrawable_spent,
      bonus_spent: spendBreakdown.bonus_spent,
    });
  });

  return { orderId, phoneNumber: availableStockNumber, expiresAt, countryName: country.country_name };
}

module.exports = { purchase, PurchaseError };
