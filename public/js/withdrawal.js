'use strict';

let withdrawalUser = null;
let currentBalance = 0;
let selectedBank = '';

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

firebase.auth().onAuthStateChanged(user => {
  if (!user) {
    window.location.replace('/');
    return;
  }
  withdrawalUser = user;
  loadWithdrawalHistory();
});

document.getElementById('withdrawal-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!withdrawalUser) return;

  const amount = Number(document.getElementById('withdrawal-amount').value);
  const bank = selectedBank;
  const accountNumber = document.getElementById('withdrawal-account').value.trim();
  const button = document.getElementById('withdrawal-submit');
  if (!bank) {
    showMessage('Pilih bank atau e-wallet tujuan.', true);
    return;
  }
  if (!Number.isSafeInteger(amount) || amount < 15000) {
    showMessage('Minimal penarikan adalah Rp 15.000.', true);
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

  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mengirim...';
  try {
    const response = await withdrawalFetch('/api/withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount, bank, account_number: accountNumber }),
    });
    const data = await parseWithdrawalResponse(response);

    showMessage(data.message || 'Permintaan penarikan berhasil dikirim.');
    event.target.reset();
    selectBank('');
    document.querySelectorAll('.amount-preset').forEach(preset => preset.classList.remove('active'));
    await loadWithdrawalHistory();
  } catch (error) {
    showMessage(error.message || 'Terjadi kesalahan saat mengirim permintaan.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Kirim Permintaan';
  }
});

async function loadWithdrawalHistory() {
  if (!withdrawalUser) return;
  const historyEl = document.getElementById('withdrawal-history');
  try {
    const response = await withdrawalFetch('/api/withdrawals');
    const data = await parseWithdrawalResponse(response);

    currentBalance = Number(data.balance) || 0;
    document.getElementById('available-balance').textContent = formatRupiah(currentBalance);
    renderHistory(Array.isArray(data.withdrawals) ? data.withdrawals : []);
  } catch (error) {
    historyEl.textContent = error.message || 'Riwayat penarikan tidak dapat dimuat.';
    document.getElementById('available-balance').textContent = 'Tidak tersedia';
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
    throw new Error(data.message || `Permintaan gagal (HTTP ${response.status}).`);
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
    REJECTED: ['Ditolak · saldo dikembalikan', 'status-rejected'],
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
    fee.textContent = `Biaya gratis · ${formatDate(withdrawal.created_at)}`;
    item.append(heading, destination, fee);
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

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('id-ID');
}
