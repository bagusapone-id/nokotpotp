const { db } = require('../config/firebase');
const { retryTransaction } = require('../utils/retryTransaction');

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
    await db.ref(`users/${uid}`).set({
      username: username || uid,
      balance: 0,
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

  // 3. Find one AVAILABLE stock entry
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
    const balanceRef = db.ref(`users/${uid}/balance`);

    const txResult = await balanceRef.transaction((bal) => {
      // Firebase calls this with null first (optimistic concurrency check).
      // Returning null tells Firebase "no data here yet, skip" - 
      // it will retry with the real value.
      if (bal === null) return null;

      const balance = Number(bal) || 0;
      if (balance < price) {
        // Return undefined to ABORT the transaction
        return undefined;
      }
      return balance - price;
    });

    if (!txResult.committed) {
      // Re-read actual balance to give accurate error
      const freshSnap = await db.ref(`users/${uid}/balance`).once('value');
      const freshBalance = freshSnap.val() || 0;
      throw new PurchaseError(
        'INSUFFICIENT_BALANCE',
        `Saldo tidak mencukupi. Saldo: Rp ${Number(freshBalance).toLocaleString('id-ID')}, Harga: Rp ${Number(price).toLocaleString('id-ID')}.`
      );
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
    });
  });

  return { orderId, phoneNumber: availableStockNumber, expiresAt, countryName: country.country_name };
}

module.exports = { purchase, PurchaseError };
