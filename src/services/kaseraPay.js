'use strict';

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://pay.kasera.id';

function getConfig() {
  const apiKey = process.env.KASERA_API_KEY || process.env.KASERA_PAY_KEY;
  if (!apiKey) {
    const error = new Error('Missing required environment variable: KASERA_API_KEY');
    error.status = 503;
    error.code = 'kasera_configuration';
    error.publicMessage = 'Kasera Pay belum dikonfigurasi di server. Tambahkan KASERA_API_KEY pada environment server.';
    throw error;
  }

  const baseUrl = (process.env.KASERA_PAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.origin !== DEFAULT_BASE_URL || parsedBaseUrl.username || parsedBaseUrl.password) {
    const error = new Error(`KASERA_PAY_BASE_URL must use ${DEFAULT_BASE_URL}.`);
    error.status = 503;
    error.code = 'kasera_configuration';
    error.publicMessage = 'Konfigurasi URL Kasera Pay di server tidak valid.';
    throw error;
  }
  return { apiKey, baseUrl: parsedBaseUrl.origin };
}

async function request(path, options) {
  const { apiKey, baseUrl } = getConfig();
  let response;
  try {
    const fetchImpl = typeof global.fetch === 'function' ? global.fetch : require('node-fetch');
    response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options && options.headers),
      },
    });
  } catch (cause) {
    const error = new Error('Kasera Pay request could not be reached.');
    error.status = 503;
    error.code = 'kasera_unavailable';
    error.publicMessage = 'Layanan Kasera Pay tidak dapat dijangkau. Coba lagi beberapa saat.';
    error.cause = cause;
    throw error;
  }
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const code = data && data.error && data.error.code;
    const error = new Error(`Kasera Pay request failed (${response.status}${code ? `: ${code}` : ''})`);
    error.status = response.status;
    error.code = code;
    throw error;
  }

  return data;
}

function createTransaction(input, idempotencyKey) {
  return request('/v1/transactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
}

function getTransaction(id) {
  return request(`/v1/transactions/${encodeURIComponent(id)}`, { method: 'GET' });
}

function calculateGrossAmount(netAmount, fee) {
  const percentBps = fee.percent_bps;
  const flat = fee.flat;
  if (!Number.isSafeInteger(percentBps) ||
      !Number.isSafeInteger(flat) ||
      percentBps < 0 ||
      percentBps >= 10000 ||
      flat < 0) return null;

  const feeForGross = amount => Math.ceil(amount * percentBps / 10000) + flat;
  let grossAmount = Math.ceil((netAmount + flat) * 10000 / (10000 - percentBps));
  while (grossAmount - feeForGross(grossAmount) < netAmount) grossAmount += 1;
  while (grossAmount > 1 &&
      grossAmount - 1 - feeForGross(grossAmount - 1) >= netAmount) grossAmount -= 1;
  return grossAmount;
}

async function getEligiblePaymentMethods(amount) {
  const response = await request('/v1/payment_methods', { method: 'GET' });
  if (!response || !Array.isArray(response.data)) {
    const error = new Error('Kasera Pay returned an invalid payment method list.');
    error.status = 502;
    error.code = 'kasera_invalid_methods';
    error.publicMessage = 'Kasera Pay mengembalikan daftar metode pembayaran yang tidak valid.';
    throw error;
  }

  return response.data
    .map(method => {
      if (!method || typeof method.code !== 'string' ||
          !Array.isArray(method.required_customer_fields)) return false;
      const requiredFields = method.required_customer_fields;
      const isQris = method.code === 'qris' && method.type === 'qr';
      const isBank = /^va_[a-z0-9_]+$/.test(method.code) &&
        method.type === 'payment_code' &&
        requiredFields.includes('customer.name');
      const isEwallet = method.type === 'redirect' &&
        requiredFields.includes('customer.phone') &&
        !requiredFields.includes('customer.name') &&
        !requiredFields.includes('customer.email') &&
        !requiredFields.includes('customer.address');
      if (!isQris && !isBank && !isEwallet) return false;
      if (!Number.isSafeInteger(method.min_amount) ||
          !Number.isSafeInteger(method.max_amount)) return false;
      const totalAmount = calculateGrossAmount(amount, method.fee || {});
      if (totalAmount === null ||
          totalAmount < method.min_amount ||
          totalAmount > method.max_amount ||
          totalAmount > 10000000) return false;

      return {
        code: method.code,
        display_name: method.display_name,
        total_amount: totalAmount,
        fee_amount: totalAmount - amount,
      };
    })
    .filter(Boolean);
}

function verifyWebhookSignature(rawBody, signatureHeader, secret, now = Date.now()) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !secret) return false;

  const parts = signatureHeader.split(',').map(part => part.trim());
  const timestampMatch = /^t=(\d+)$/.exec(parts[0] || '');
  if (!timestampMatch) return false;

  const timestamp = Number(timestampMatch[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();

  return parts.slice(1).some(part => {
    const match = /^v1=([a-f\d]{64})$/i.exec(part);
    if (!match) return false;
    const received = Buffer.from(match[1], 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

module.exports = {
  createTransaction,
  getTransaction,
  getEligiblePaymentMethods,
  verifyWebhookSignature,
};
