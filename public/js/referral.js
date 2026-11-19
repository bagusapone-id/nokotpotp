'use strict';

const inviteLinkEl = document.getElementById('invite-link');
const copyButton = document.getElementById('copy-link-btn');
const referralCodeDisplay = document.getElementById('referral-code-display');
const copyCodeButton = document.getElementById('copy-code-btn');
const copyMessage = document.getElementById('copy-message');
let referralUser = null;
let claimValidationSequence = 0;
let claimValidationTimer = null;
let claimCodeValid = false;

firebase.auth().onAuthStateChanged(async user => {
  if (!user) {
    window.location.replace('/');
    return;
  }

  referralUser = user;
  await loadReferralData(user);
});

async function loadReferralData(user) {
  try {
    const token = await user.getIdToken();
    const response = await fetch('/api/user/referrals', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Gagal memuat data referral.');

    const inviteLink = `${window.location.origin}/daftar?ref=${encodeURIComponent(data.referral_code)}`;
    referralCodeDisplay.textContent = data.referral_code;
    inviteLinkEl.textContent = inviteLink;
    copyButton.disabled = false;
    copyCodeButton.disabled = false;
    copyButton.onclick = () => copyInviteLink(inviteLink);
    copyCodeButton.onclick = () => copyInviteCode(data.referral_code);

    document.getElementById('invited-count').textContent = data.invited_count;
    document.getElementById('total-earned').textContent = formatRupiah(data.total_earned);
    document.getElementById('claim-referral-card').style.display = data.can_claim_referral ? 'block' : 'none';
    renderCommissionHistory(data.history);
    renderReferralList(data.referrals);
  } catch (error) {
    const errorEl = document.getElementById('error-message');
    errorEl.textContent = error.message || 'Terjadi kesalahan saat memuat data referral.';
    errorEl.style.display = 'block';
    document.getElementById('commission-history').textContent = 'Riwayat tidak dapat dimuat.';
    document.getElementById('referral-list').textContent = 'Daftar teman tidak dapat dimuat.';
  }
}

window.validateClaimReferralCode = function() {
  const input = document.getElementById('claim-referral-code');
  const status = document.getElementById('claim-referral-status');
  const submitButton = document.getElementById('claim-referral-submit');
  const code = input.value.trim().toUpperCase();
  input.value = code;
  claimCodeValid = false;
  const requestId = ++claimValidationSequence;
  clearTimeout(claimValidationTimer);

  if (!code) {
    status.textContent = '';
    status.style.display = 'none';
    submitButton.disabled = true;
    return;
  }
  if (!/^NOKOTP[A-HJ-NP-Z2-9]{5}$/.test(code)) {
    status.textContent = 'Format kode harus NOKOTP + 5 karakter.';
    status.style.color = '#fb7185';
    status.style.display = 'block';
    submitButton.disabled = true;
    return;
  }

  status.textContent = 'Memeriksa kode referral...';
  status.style.color = '#fbbf24';
  status.style.display = 'block';
  submitButton.disabled = true;
  claimValidationTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/register/validate-referral-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: code }),
      });
      const data = await response.json();
      if (requestId !== claimValidationSequence) return;
      if (!response.ok) throw new Error(data.message || 'Gagal memeriksa kode referral.');

      claimCodeValid = Boolean(data.valid);
      status.textContent = data.message;
      status.style.color = claimCodeValid ? '#c084fc' : '#fb7185';
    } catch (error) {
      if (requestId !== claimValidationSequence) return;
      claimCodeValid = false;
      status.textContent = error.message || 'Gagal memeriksa kode referral.';
      status.style.color = '#fb7185';
    }
    status.style.display = 'block';
    submitButton.disabled = !claimCodeValid;
  }, 300);
};

document.getElementById('claim-referral-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!claimCodeValid || !referralUser) return;

  const button = document.getElementById('claim-referral-submit');
  const status = document.getElementById('claim-referral-status');
  button.disabled = true;
  try {
    const token = await referralUser.getIdToken();
    const response = await fetch('/api/user/referrals/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ referralCode: document.getElementById('claim-referral-code').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Gagal mengaitkan kode referral.');

    status.textContent = 'Kode referral berhasil dikaitkan.';
    status.style.color = '#c084fc';
    claimCodeValid = false;
    document.getElementById('claim-referral-code').value = '';
    await loadReferralData(referralUser);
  } catch (error) {
    status.textContent = error.message || 'Gagal mengaitkan kode referral.';
    status.style.color = '#fb7185';
    button.disabled = !claimCodeValid;
  }
});

async function copyInviteLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    copyMessage.textContent = 'Link undangan berhasil disalin.';
  } catch {
    copyMessage.textContent = 'Gagal menyalin otomatis. Salin link yang tampil di atas.';
  }
}

async function copyInviteCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    copyMessage.textContent = 'Kode referral berhasil disalin.';
  } catch {
    copyMessage.textContent = 'Gagal menyalin otomatis. Salin kode yang tampil di atas.';
  }
}

function renderCommissionHistory(history) {
  const container = document.getElementById('commission-history');
  if (!history.length) {
    container.innerHTML = '<div class="empty">Belum ada komisi. Bagikan link undanganmu untuk mulai mengajak teman.</div>';
    return;
  }

  container.replaceChildren(...history.map(entry => {
    const row = document.createElement('div');
    row.className = 'history-list-item';
    const name = document.createElement('div');
    name.style.cssText = 'font-weight:700;color:#e2e8f0;margin-bottom:4px';
    name.textContent = entry.referred_username || 'Teman';
    const detail = document.createElement('div');
    detail.textContent = `Deposit ${formatRupiah(entry.deposit_amount)} · ${formatDate(entry.created_at)}`;
    const amount = document.createElement('div');
    amount.style.cssText = 'margin-top:5px;font-weight:700;color:#d8b4fe';
    amount.textContent = `+${formatRupiah(entry.commission)}`;
    row.append(name, detail, amount);
    return row;
  }));
}

function renderReferralList(referrals) {
  const container = document.getElementById('referral-list');
  if (!referrals.length) {
    container.innerHTML = '<div class="empty">Belum ada teman yang bergabung melalui link undanganmu.</div>';
    return;
  }

  container.replaceChildren(...referrals.map(referral => {
    const row = document.createElement('div');
    row.className = 'history-list-item';
    const name = document.createElement('div');
    name.style.cssText = 'font-weight:700;color:#e2e8f0;margin-bottom:4px';
    name.textContent = referral.username || 'Teman';
    const joined = document.createElement('div');
    joined.textContent = `Bergabung ${formatDate(referral.joined_at)}`;
    row.append(name, joined);
    return row;
  }));
}

function formatRupiah(amount) {
  return `Rp ${Number(amount || 0).toLocaleString('id-ID')}`;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('id-ID');
}
