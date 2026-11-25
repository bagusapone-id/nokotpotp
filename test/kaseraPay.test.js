'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  createTransaction,
  getEligiblePaymentMethods,
  verifyWebhookSignature,
} = require('../src/services/kaseraPay');

function signedHeader(rawBody, secret, timestamp, extraSignatures = []) {
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return [`t=${timestamp}`, ...extraSignatures.map(value => `v1=${value}`), `v1=${signature}`].join(',');
}

test('verifies Kasera timestamped signatures and accepts rotated secrets', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const now = 1_800_000_000_000;
  const header = signedHeader(body, 'webhook-secret', now / 1000, ['0'.repeat(64)]);

  assert.equal(verifyWebhookSignature(body, header, 'webhook-secret', now), true);
  assert.equal(verifyWebhookSignature(body, header, 'wrong-secret', now), false);
});

test('rejects malformed, stale, and non-raw webhook requests', () => {
  const body = Buffer.from('{"id":"evt_1"}');
  const now = 1_800_000_000_000;
  const staleHeader = signedHeader(body, 'webhook-secret', now / 1000 - 301);

  assert.equal(verifyWebhookSignature(body, staleHeader, 'webhook-secret', now), false);
  assert.equal(verifyWebhookSignature(body, 't=bad,v1=invalid', 'webhook-secret', now), false);
  assert.equal(verifyWebhookSignature('{"id":"evt_1"}', staleHeader, 'webhook-secret', now), false);
});

test('creates Kasera requests with bearer auth and an idempotency key', async () => {
  const previousKey = process.env.KASERA_API_KEY;
  const previousBaseUrl = process.env.KASERA_PAY_BASE_URL;
  const originalFetch = global.fetch;
  let requestUrl;
  let requestOptions;
  let fetchCalls = 0;

  process.env.KASERA_API_KEY = 'test-key';
  process.env.KASERA_PAY_BASE_URL = 'https://pay.kasera.id';
  global.fetch = async (url, options) => {
    fetchCalls += 1;
    requestUrl = url;
    requestOptions = options;
    return { ok: true, json: async () => ({ id: 'payreq_test' }) };
  };

  try {
    const response = await createTransaction({ amount: 5000 }, 'DEP-test');

    assert.deepEqual(response, { id: 'payreq_test' });
    assert.equal(requestUrl, 'https://pay.kasera.id/v1/transactions');
    assert.equal(requestOptions.headers.Authorization, 'Bearer test-key');
    assert.equal(requestOptions.headers['Idempotency-Key'], 'DEP-test');
    assert.deepEqual(JSON.parse(requestOptions.body), { amount: 5000 });

    process.env.KASERA_PAY_BASE_URL = 'https://attacker.example';
    await assert.rejects(createTransaction({ amount: 5000 }, 'DEP-test'), /KASERA_PAY_BASE_URL/);
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.KASERA_API_KEY;
    else process.env.KASERA_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.KASERA_PAY_BASE_URL;
    else process.env.KASERA_PAY_BASE_URL = previousBaseUrl;
  }
});

test('only returns active QRIS, bank, and supported e-wallet methods within their limits', async () => {
  const previousKey = process.env.KASERA_API_KEY;
  const previousBaseUrl = process.env.KASERA_PAY_BASE_URL;
  const originalFetch = global.fetch;
  process.env.KASERA_API_KEY = 'test-key';
  process.env.KASERA_PAY_BASE_URL = 'https://pay.kasera.id';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://pay.kasera.id/v1/payment_methods');
    assert.equal(options.method, 'GET');
    return {
      ok: true,
      json: async () => ({
        data: [
          { code: 'qris', display_name: 'QRIS', type: 'qr', required_customer_fields: [], min_amount: 5000, max_amount: 1000000, fee: { percent_bps: 70, flat: 250 } },
          { code: 'va_bri', display_name: 'BRI Virtual Account', type: 'payment_code', required_customer_fields: ['customer.name'], min_amount: 10000, max_amount: 1000000, fee: { percent_bps: 500, flat: 0 } },
          { code: 'ovo', display_name: 'OVO', type: 'redirect', required_customer_fields: ['customer.phone'], min_amount: 5000, max_amount: 500000, fee: { percent_bps: 100, flat: 0 } },
          { code: 'akulaku', display_name: 'Akulaku', type: 'redirect', required_customer_fields: ['customer.name', 'customer.email', 'customer.phone'], min_amount: 5000, max_amount: 500000, fee: { percent_bps: 100, flat: 0 } },
          { code: 'alfamart', display_name: 'Alfamart', type: 'payment_code', required_customer_fields: [], min_amount: 10000, max_amount: 500000, fee: { percent_bps: 100, flat: 0 } },
          { code: 'va_bni', display_name: 'BNI Virtual Account', type: 'payment_code', required_customer_fields: ['customer.name'], min_amount: 10000, max_amount: 1000000, fee: { percent_bps: 500, flat: 0 } },
          { code: 'va_mandiri', display_name: 'Mandiri Virtual Account', type: 'payment_code', required_customer_fields: ['customer.name'], min_amount: 10000, max_amount: 10500, fee: { percent_bps: 500, flat: 0 } },
        ],
      }),
    };
  };

  try {
    assert.deepEqual(await getEligiblePaymentMethods(5000), [
      { code: 'qris', display_name: 'QRIS', total_amount: 5288, fee_amount: 288 },
      { code: 'ovo', display_name: 'OVO', total_amount: 5051, fee_amount: 51 },
    ]);
    assert.deepEqual(await getEligiblePaymentMethods(10000), [
      { code: 'qris', display_name: 'QRIS', total_amount: 10323, fee_amount: 323 },
      { code: 'va_bri', display_name: 'BRI Virtual Account', total_amount: 10527, fee_amount: 527 },
      { code: 'ovo', display_name: 'OVO', total_amount: 10102, fee_amount: 102 },
      { code: 'va_bni', display_name: 'BNI Virtual Account', total_amount: 10527, fee_amount: 527 },
    ]);
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.KASERA_API_KEY;
    else process.env.KASERA_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.KASERA_PAY_BASE_URL;
    else process.env.KASERA_PAY_BASE_URL = previousBaseUrl;
  }
});

test('reports missing Kasera API configuration without hiding it as a generic failure', async () => {
  const previousKey = process.env.KASERA_API_KEY;
  const previousLegacyKey = process.env.KASERA_PAY_KEY;
  delete process.env.KASERA_API_KEY;
  delete process.env.KASERA_PAY_KEY;

  try {
    await assert.rejects(getEligiblePaymentMethods(5000), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'kasera_configuration');
      assert.match(error.publicMessage, /KASERA_API_KEY/);
      return true;
    });
  } finally {
    if (previousKey === undefined) delete process.env.KASERA_API_KEY;
    else process.env.KASERA_API_KEY = previousKey;
    if (previousLegacyKey === undefined) delete process.env.KASERA_PAY_KEY;
    else process.env.KASERA_PAY_KEY = previousLegacyKey;
  }
});
