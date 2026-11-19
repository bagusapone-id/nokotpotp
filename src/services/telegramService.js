// Node 18+ has native fetch — no require needed.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

function buildMessage(type, payload) {
  const lines = [
    `&#128276; <b>Event:</b> ${type}`,
    `&#128203; <b>Order ID:</b> <code>${payload.order_id || '-'}</code>`,
    `&#128100; <b>Username:</b> ${payload.username || '-'}`,
    `&#128241; <b>Nomor HP:</b> <code>${payload.phone_number || '-'}</code>`,
    `&#127758; <b>Negara:</b> ${payload.country_name || '-'}`,
  ];
  if (payload.resend_count !== undefined) {
    lines.push(`&#128260; <b>Resend ke-${payload.resend_count}</b>`);
  }
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value || '-').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

async function sendTelegramMessage(text, context = {}) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.warn('[Telegram] BOT_TOKEN or ADMIN_CHAT_ID not configured.');
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML' }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('[Telegram] Notification failed:', {
        ...context,
        http_status: response.status,
        response_body: body,
      });
    }
  } catch (err) {
    console.error('[Telegram] Network error:', { ...context, error: err.message });
  }
}

/**
 * Send Telegram notification. Never throws.
 */
async function sendNotification(type, payload) {
  await sendTelegramMessage(buildMessage(type, payload), { order_id: payload.order_id });
}

async function sendWithdrawalNotification(payload) {
  const text = [
    '&#128176; <b>Permintaan Penarikan Saldo</b>',
    `&#128203; <b>ID:</b> <code>${escapeHtml(payload.withdrawal_id)}</code>`,
    `&#128100; <b>Username:</b> ${escapeHtml(payload.username)}`,
    `&#128181; <b>Nominal:</b> ${escapeHtml(payload.amount.toLocaleString('id-ID'))}`,
    `&#127974; <b>Bank/E-wallet:</b> ${escapeHtml(payload.bank)}`,
    `&#128179; <b>Nomor rekening:</b> <code>${escapeHtml(payload.account_number)}</code>`,
    '&#128176; <b>Biaya:</b> Gratis',
  ].join('\n');
  await sendTelegramMessage(text, { withdrawal_id: payload.withdrawal_id });
}

module.exports = { sendNotification, sendWithdrawalNotification };