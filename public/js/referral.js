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
let referralAccessPollTimer = null;
let referralListenerRefs = [];
let referralDataLoaded = false;
let referralDataLoading = false;
const referralLiveData = { code: '', earnings: {}, referrals: {}, attribution: null };

firebase.auth().onAuthStateChanged(async user => {
  if (!user) {
    stopReferralListeners();
    window.location.replace('/');
    return;
  }

  referralUser = user;
  await loadReferralData(user);
});

function stopReferralListeners() {
  if (referralAccessPollTimer) {
    clearInterval(referralAccessPollTimer);
    referralAccessPollTimer = null;
  }
  referralListenerRefs.forEach(ref => ref.off());
  referralListenerRefs = [];
}

async function loadReferralData(user) {
  if (referralDataLoading) return;
  referralDataLoading = true;
  try {
    const token = await user.getIdToken();
    const response = await fetch('/api/user/referrals', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      const needsSuccessfulDeposit =
        response.status === 403 && data.error === 'SUCCESSFUL_DEPOSIT_REQUIRED';
      showReferralAccessMessage(
        data.message || 'Gagal memuat data referral.',
        needsSuccessfulDeposit ? 'locked' : 'error'
      );
      if (needsSuccessfulDeposit) pollForReferralAccess(user);
      return false;
    }

    if (referralAccessPollTimer) {
      clearInterval(referralAccessPollTimer);
      referralAccessPollTimer = null;
    }
    referralLiveData.code = data.referral_code;
    referralLiveData.earnings = Object.fromEntries((data.history || []).map(item => [item.deposit_id, item]));
    referralLiveData.referrals = Object.fromEntries((data.referrals || []).map(item => [item.user_id, item]));
    referralLiveData.attribution = data.can_claim_referral ? null : true;
    showReferralPage();
    renderReferralData();
    if (!referralDataLoaded) {
      referralDataLoaded = true;
      listenForReferralUpdates(user);
    }
    return true;
  } catch (error) {
    showReferralAccessMessage(
      error.message || 'Terjadi kesalahan saat memuat data referral.',
      'error'
    );
    return false;
  } finally {
    referralDataLoading = false;
  }
}

function pollForReferralAccess(user) {
  if (referralAccessPollTimer) return;
  referralAccessPollTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') loadReferralData(user);
  }, 5000);
}

function listenForReferralUpdates(user) {
  stopReferralListeners();
  const refs = [
    ['code', firebaseDB.ref(`users/${user.uid}/referral_code`)],
    ['earnings', firebaseDB.ref(`users/${user.uid}/referral_earnings`)],
    ['referrals', firebaseDB.ref(`referrals/${user.uid}`)],
    ['attribution', firebaseDB.ref(`referral_attributions/${user.uid}`)],
  ];

  refs.forEach(([key, ref]) => {
    referralListenerRefs.push(ref);
    ref.on('value', snap => {
      referralLiveData[key] = snap.val();
      renderReferralData();
    }, error => {
      showReferralAccessMessage(error.message || 'Gagal memperbarui data referral.', 'error');
    });
  });
}

function showReferralPage() {
  document.querySelectorAll('.deposit-required').forEach(link => {
    link.hidden = false;
  });
  document.getElementById('referral-loading').hidden = true;
  document.getElementById('referral-locked').hidden = true;
  document.getElementById('referral-page').hidden = false;
  document.getElementById('referral-nav').hidden = false;
}

function renderReferralData() {
  const code = referralLiveData.code;
  if (typeof code === 'string' && code) {
    const inviteLink = `${window.location.origin}/daftar?ref=${encodeURIComponent(code)}`;
    referralCodeDisplay.textContent = code;
    inviteLinkEl.textContent = inviteLink;
    copyButton.disabled = false;
    copyCodeButton.disabled = false;
    copyButton.onclick = () => copyInviteLink(inviteLink);
    copyCodeButton.onclick = () => copyInviteCode(code);
  }

  const history = Object.entries(referralLiveData.earnings || {})
    .map(([depositId, earning]) => ({ deposit_id: depositId, ...earning }))
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  const referrals = Object.entries(referralLiveData.referrals || {})
    .map(([userId, referral]) => ({ user_id: userId, ...referral }))
    .sort((a, b) => Number(b.joined_at || 0) - Number(a.joined_at || 0));

  document.getElementById('invited-count').textContent = referrals.length;
  document.getElementById('total-earned').textContent = formatRupiah(
    history.reduce((total, earning) => total + (Number(earning.commission) || 0), 0)
  );
  document.getElementById('claim-referral-card').style.display =
    referralLiveData.attribution ? 'none' : 'block';
  renderCommissionHistory(history);
  renderReferralList(referrals);
}

function showReferralAccessMessage(message, state) {
  document.getElementById('referral-loading').hidden = true;
  document.getElementById('referral-page').hidden = true;
  document.getElementById('referral-nav').hidden = true;
  document.getElementById('referral-locked').hidden = false;
  const icon = document.getElementById('referral-access-icon');
  icon.classList.toggle('is-error', state === 'error');
  const iconElement = document.createElement('i');
  iconElement.className = state === 'locked' ? 'fa-solid fa-lock' : 'fa-solid fa-circle-exclamation';
  icon.replaceChildren(iconElement);
  document.getElementById('referral-access-title').textContent =
    state === 'locked' ? 'Undang teman belum tersedia' : 'Akses referral gagal diperiksa';
  document.getElementById('referral-access-message').textContent = message;
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
