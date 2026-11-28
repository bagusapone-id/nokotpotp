'use strict';

let withdrawalUser = null;
let currentBalance = 0;
let selectedBank = '';
let userRecordRef = null;
let withdrawalRequestsRef = null;
let withdrawalAccessPollTimer = null;
let liveWithdrawalHistory = [];
let hasSuccessfulDeposit = false;
let withdrawalAccessGranted = false;
let withdrawalAccessChecked = false;
let withdrawalHistoryLoading = false;
let lastAccessAttemptFingerprint = '';

const MINIMUM_BALANCE_TO_WITHDRAW = 15000;

document.querySelectorAll('.bank-option').forEach(button => {
  button.addEventListener('click', () => selectBank(button.dataset.bank));
});

document.querySelectorAll('.amount-preset').forEach(button => {
  button.addEventListener('click', () => {
    const amountInput = document.getElementById('withdrawal-amount');
    amountInput.value = button.dataset.amount;
    document.querySelectorAll('.amount-preset').forEach(preset => {
      preset.classList.toggle('active', preset === button);
    });
  });
});

document.getElementById('withdrawal-amount').addEventListener('input', () => {
  const value = document.getElementById('withdrawal-amount').value;
  document.querySelectorAll('.amount-preset').forEach(button => {
    button.classList.toggle('active', button.dataset.amount === value);
  });
});

function selectBank(bank) {
  selectedBank = bank;
  document.querySelectorAll('.bank-option').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.bank === bank));
  });
}

function showWithdrawalAccess(state, message) {
  document.getElementById('withdrawal-loading').hidden = state !== 'loading';
  document.getElementById('withdrawal-locked').hidden = state !== 'locked';
  document.getElementById('withdrawal-page').hidden = state !== 'available';
  document.getElementById('withdrawal-nav').hidden = state !== 'available';
  if (message) document.getElementById('withdrawal-locked-message').textContent = message;
}

firebase.auth().onAuthStateChanged(user => {
  if (!user) {
    stopWithdrawalListeners();
    window.location.replace('/');
    return;
  }
  withdrawalUser = user;
  listenForWithdrawalUpdates(user);
  loadWithdrawalHistory();
});

function stopWithdrawalListeners() {
  [userRecordRef, withdrawalRequestsRef].forEach(ref => {
    if (ref) ref.off();
  });
  userRecordRef = null;
  withdrawalRequestsRef = null;
  if (withdrawalAccessPollTimer) {
    clearInterval(withdrawalAccessPollTimer);
    withdrawalAccessPollTimer = null;
  }
}

function listenForWithdrawalUpdates(user) {
  stopWithdrawalListeners();
  userRecordRef = firebase.database().ref(`users/${user.uid}`);
  withdrawalRequestsRef = firebase.database().ref(`withdrawal_requests/${user.uid}`);

  userRecordRef.on('value', snapshot => {
    const account = snapshot.val() || {};
    currentBalance = Number(
      account.withdrawable_balance === undefined || account.withdrawable_balance === null
        ? account.balance || 0
        : account.withdrawable_balance
    ) || 0;
    updateWithdrawalLiveView();
    syncWithdrawalAccess();
  }, error => showWithdrawalRealtimeError(error));

  withdrawalRequestsRef.on('value', snapshot => {
    liveWithdrawalHistory = Object.entries(snapshot.val() || {})
      .map(([withdrawal_id, request]) => ({ withdrawal_id, ...request }))
      .filter(request => request.status !== 'FAILED')
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    updateWithdrawalLiveView();
    syncWithdrawalAccess();
  }, error => showWithdrawalRealtimeError(error));

}

function updateWithdrawalLiveView() {
  if (document.getElementById('withdrawal-page').hidden) return;
  document.getElementById('available-balance').textContent = formatRupiah(currentBalance);
  renderHistory(liveWithdrawalHistory);
}

function syncWithdrawalAccess() {
  if (!withdrawalAccessChecked) return;
  const accessFingerprint = [
    hasSuccessfulDeposit,
    currentBalance,
    liveWithdrawalHistory.length,
  ].join(':');
  const allowed = hasSuccessfulDeposit && (
    currentBalance >= MINIMUM_BALANCE_TO_WITHDRAW || liveWithdrawalHistory.length > 0
  );
  if (!allowed) {
    withdrawalAccessGranted = false;
    startWithdrawalAccessPolling();
    showWithdrawalAccess(
      'locked',
      hasSuccessfulDeposit
        ? `Saldo utama harus minimal Rp ${MINIMUM_BALANCE_TO_WITHDRAW.toLocaleString('id-ID')} dan minimal penarikan Rp 1.000. Saldo komisi undang teman bisa di tarik.`
        : 'Fitur ini tersedia setelah minimal satu deposit berapa pun berhasil dibayar.'
    );
    return;
  }
  if (!withdrawalAccessGranted && !withdrawalHistoryLoading &&
      accessFingerprint !== lastAccessAttemptFingerprint) {
    lastAccessAttemptFingerprint = accessFingerprint;
    loadWithdrawalHistory();
  }
}

function startWithdrawalAccessPolling() {
  if (withdrawalAccessPollTimer) return;
  withdrawalAccessPollTimer = setInterval(() => {
    if (!withdrawalAccessGranted && document.visibilityState !== 'hidden') loadWithdrawalHistory();
  }, 5000);
}

function showWithdrawalRealtimeError(error) {
  console.error('[withdrawal] realtime listener error:', error.message);
  showMessage('Pembaruan data realtime gagal. Periksa koneksi dan muat ulang halaman.', true);
}

document.getElementById('withdrawal-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!withdrawalUser) return;

  const amount = Number(document.getElementById('withdrawal-amount').value);
  const bank = selectedBank;
  const accountNumber = document.getElementById('withdrawal-account').value.trim();
  const accountName = document.getElementById('withdrawal-account-name').value.trim();
  const button = document.getElementById('withdrawal-submit');
  if (!bank) {
    showMessage('Pilih bank atau e-wallet tujuan.', true);
    return;
  }
  if (!Number.isSafeInteger(amount) || amount < 1000) {
    showMessage('Minimal penarikan adalah Rp 1.000.', true);
    return;
  }
  if (amount > currentBalance) {
    showMessage('Saldo tersedia tidak mencukupi.', true);
    return;
  }
  if (!/^[0-9]{8,20}$/.test(accountNumber)) {
    showMessage('Nomor rekening harus terdiri dari 8 sampai 20 digit.', true);
    return;
  }
  if (!accountName || accountName.length < 2) {
    showMessage('Nama pemilik akun harus diisi.', true);
    return;
  }

  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mengirim...';
  try {
    const response = await withdrawalFetch('/api/withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount, bank, account_number: accountNumber, account_name: accountName }),
    });
    const data = await parseWithdrawalResponse(response);

    showMessage(data.message || 'Permintaan penarikan berhasil dikirim.');
    event.target.reset();
    selectBank('');
    document.querySelectorAll('.amount-preset').forEach(preset => preset.classList.remove('active'));
    await loadWithdrawalHistory();
  } catch (error) {
    if (['MINIMUM_BALANCE_REQUIRED', 'NO_TRANSACTIONS', 'SUCCESSFUL_DEPOSIT_REQUIRED'].includes(error.code)) {
      showMessage(error.message, true);
      return;
    }
    showMessage(error.message || 'Terjadi kesalahan saat mengirim permintaan.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Kirim Permintaan';
  }
});

async function loadWithdrawalHistory() {
  if (!withdrawalUser || withdrawalHistoryLoading) return;
  withdrawalHistoryLoading = true;
  let recheckAccess = false;
  const historyEl = document.getElementById('withdrawal-history');
  try {
    const response = await withdrawalFetch('/api/withdrawals');
    const data = await parseWithdrawalResponse(response);

    withdrawalAccessChecked = true;
    withdrawalAccessGranted = true;
    lastAccessAttemptFingerprint = '';
    hasSuccessfulDeposit = true;
    if (withdrawalAccessPollTimer) {
      clearInterval(withdrawalAccessPollTimer);
      withdrawalAccessPollTimer = null;
    }
    showWithdrawalAccess('available');
    currentBalance = Number(data.balance) || 0;
    document.getElementById('available-balance').textContent = formatRupiah(currentBalance);
    liveWithdrawalHistory = Array.isArray(data.withdrawals) ? data.withdrawals : [];
    renderHistory(liveWithdrawalHistory);
  } catch (error) {
    if (['MINIMUM_BALANCE_REQUIRED', 'NO_TRANSACTIONS', 'SUCCESSFUL_DEPOSIT_REQUIRED'].includes(error.code)) {
      withdrawalAccessChecked = true;
      withdrawalAccessGranted = false;
      hasSuccessfulDeposit = error.code !== 'SUCCESSFUL_DEPOSIT_REQUIRED';
      startWithdrawalAccessPolling();
      showWithdrawalAccess('locked', error.message);
      recheckAccess = true;
      return;
    }
    withdrawalAccessChecked = true;
    showWithdrawalAccess('available');
    historyEl.textContent = error.message || 'Riwayat penarikan tidak dapat dimuat.';
    document.getElementById('available-balance').textContent = 'Tidak tersedia';
  } finally {
    withdrawalHistoryLoading = false;
    if (recheckAccess) syncWithdrawalAccess();
  }
}

async function withdrawalFetch(url, options = {}) {
  const token = await withdrawalUser.getIdToken();
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

async function parseWithdrawalResponse(response) {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`Server mengirim respons kosong (HTTP ${response.status}).`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Respons server tidak valid (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(data.message || `Permintaan gagal (HTTP ${response.status}).`);
    error.code = data.error;
    throw error;
  }
  return data;
}

function renderHistory(withdrawals) {
  const container = document.getElementById('withdrawal-history');
  if (!withdrawals.length) {
    container.innerHTML = '<div class="empty-state"><i class="fa-regular fa-folder-open"></i>Belum ada aktivitas penarikan.</div>';
    return;
  }

  const statusLabels = {
    PROCESSING: ['Memproses', 'status-processing'],
    PENDING: ['Menunggu', 'status-pending'],
    COMPLETED: ['Selesai', 'status-completed'],
    REJECTING: ['Mengembalikan saldo', 'status-rejecting'],
    REJECTED: ['Ditolak', 'status-rejected'],
  };
  container.replaceChildren(...withdrawals.map(withdrawal => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const heading = document.createElement('div');
    heading.className = 'history-row';
    const amount = document.createElement('strong');
    amount.className = 'history-amount';
    amount.textContent = formatRupiah(withdrawal.amount);
    const [statusText, statusClass] = statusLabels[withdrawal.status] || ['Status tidak diketahui', 'status-pending'];
    const status = document.createElement('span');
    status.className = `history-status ${statusClass}`;
    status.textContent = statusText;
    heading.append(amount, status);

    const destination = document.createElement('div');
    destination.className = 'history-meta';
    destination.textContent = `${withdrawal.bank || '-'} · ${maskAccountNumber(withdrawal.account_number)}`;
    const fee = document.createElement('div');
    fee.className = 'history-meta';
    const nameLine = withdrawal.account_name ? ` · a/n ${withdrawal.account_name}` : '';
    fee.textContent = `Biaya gratis · ${formatDate(withdrawal.created_at)}${nameLine}`;
    item.append(heading, destination, fee);

    // Tampilkan alasan penolakan jika ada
    if (withdrawal.status === 'REJECTED' && withdrawal.rejection_reason) {
      const reason = document.createElement('div');
      reason.className = 'history-meta';
      reason.style.cssText = 'margin-top:5px;padding:6px 9px;border-radius:7px;background:var(--rose-dim);border:1px solid var(--rose-bdr);color:#ffa198';
      reason.innerHTML = '<i class="fa-solid fa-circle-info" style="font-size:10px;margin-right:5px"></i>Alasan: ' + escapeHtml(withdrawal.rejection_reason);
      item.append(reason);
    }
    return item;
  }));
}

function maskAccountNumber(value) {
  const number = String(value || '');
  return number.length > 4 ? `${'•'.repeat(number.length - 4)}${number.slice(-4)}` : number;
}

function showMessage(message, isError = false) {
  const element = document.getElementById('withdrawal-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.style.display = 'block';
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('id-ID');
}
