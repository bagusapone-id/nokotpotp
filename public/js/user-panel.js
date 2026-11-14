// =============================================
// USER PANEL
// =============================================

let currentUser = null;
let idToken = null;
let activeOrderId = null;
let currentTab = "indo";
let timerInterval = null;
let resendCooldownInterval = null;
let orderListenerRef = null;
let balanceListenerRef = null;

// ---- Auth tab switch ----
window.showAuthTab = function(tab) {
  const loginForm = document.getElementById("login-form");
  const regForm   = document.getElementById("register-form");
  const loginBtn  = document.getElementById("tab-login-btn");
  const regBtn    = document.getElementById("tab-register-btn");
  document.getElementById("auth-error").classList.add("hidden");
  document.getElementById("auth-success").classList.add("hidden");
  if (tab === "login") {
    loginForm.style.display = "flex";
    regForm.style.display   = "none";
    loginBtn.classList.add("active");
    regBtn.classList.remove("active");
  } else {
    loginForm.style.display = "none";
    regForm.style.display   = "flex";
    regBtn.classList.add("active");
    loginBtn.classList.remove("active");
  }
};

// ---- Login ----
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("auth-error");
  errEl.classList.add("hidden");
  try {
    await firebaseAuth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    errEl.textContent = "Login gagal: " + mapAuthError(err.code);
    errEl.classList.remove("hidden");
  }
});

// ---- Register ----
document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("reg-username").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const errEl = document.getElementById("auth-error");
  const successEl = document.getElementById("auth-success");
  errEl.classList.add("hidden");
  successEl.classList.add("hidden");

  if (!username) {
    errEl.textContent = "Username tidak boleh kosong.";
    errEl.classList.remove("hidden");
    return;
  }

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Mendaftar...";

  try {
    // 1. Create Firebase Auth account
    const cred = await firebaseAuth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: username });

    // 2. Get ID token
    const token = await cred.user.getIdToken();

    // 3. Create user record via backend (bypasses DB rules)
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token, username: username }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      errEl.textContent = "Daftar gagal: " + (data.message || "Kesalahan server.");
      errEl.classList.remove("hidden");
      // Rollback: delete the auth account
      await cred.user.delete();
      return;
    }

    successEl.textContent = "Akun berhasil dibuat! Selamat datang, " + username + ".";
    successEl.classList.remove("hidden");
    // onAuthStateChanged will handle the app display
  } catch (err) {
    errEl.textContent = "Daftar gagal: " + mapAuthError(err.code);
    errEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Buat Akun";
  }
});

function mapAuthError(code) {
  const map = {
    "auth/email-already-in-use": "Email sudah terdaftar.",
    "auth/invalid-email": "Format email tidak valid.",
    "auth/weak-password": "Password terlalu lemah (min. 6 karakter).",
    "auth/user-not-found": "Email tidak ditemukan.",
    "auth/wrong-password": "Password salah.",
    "auth/invalid-credential": "Email atau password salah.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.",
  };
  return map[code] || "Terjadi kesalahan (" + code + ").";
}

// ---- Auth state ----
firebaseAuth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    idToken = await user.getIdToken();
    showApp();
  } else {
    currentUser = null;
    idToken = null;
    showLoginScreen();
  }
});

firebaseAuth.onIdTokenChanged(async (user) => {
  if (user) idToken = await user.getIdToken();
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  cleanupListeners();
  await firebaseAuth.signOut();
});

// ---- Screens ----
function showSuccessModal(message) {
  document.getElementById("success-message").textContent = message;
  document.getElementById("success-modal").classList.remove("hidden");
}

function showLoginScreen() {
  const ls = document.getElementById("login-screen");
  ls.classList.remove("hidden");
  ls.style.display = "flex"; // harus flex agar align-items & justify-content bekerja
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("app-screen").style.display = "none";
}

function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");
  initApp();
}

function cleanupListeners() {
  if (orderListenerRef) { orderListenerRef.off(); orderListenerRef = null; }
  if (balanceListenerRef) { balanceListenerRef.off(); balanceListenerRef = null; }
  if (autoOtpTimeout) { clearTimeout(autoOtpTimeout); autoOtpTimeout = null; }
  clearInterval(timerInterval);
  clearInterval(resendCooldownInterval);
  activeOrderId = null;
}

// ---- Init ----
function initApp() {
  setupConnectionListener();
  setupBalanceListener();
  setupCountriesAndStockListener();
  checkForActiveOrder();
}

// ---- Helpers ----
function formatRupiah(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

function showError(msg) {
  const b = document.getElementById("error-banner");
  document.getElementById("error-banner-text").textContent = msg;
  b.classList.remove("hidden");
}

function hideError() {
  document.getElementById("error-banner").classList.add("hidden");
}

async function apiFetch(url, opts = {}) {
  if (currentUser) idToken = await currentUser.getIdToken(true);
  return fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + idToken,
      ...(opts.headers || {}),
    },
  });
}

// Safe JSON parse — returns {} if body is empty or not valid JSON
async function safeJson(res) {
  const text = await res.text();
  if (!text || !text.trim()) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const ERROR_MAP = {
  INSUFFICIENT_BALANCE: "Saldo tidak mencukupi.",
  OUT_OF_STOCK: "Stok habis untuk negara ini.",
  INVALID_COUNTRY: "Negara tidak valid.",
  TRANSACTION_FAILED: "Transaksi gagal, coba lagi.",
  SERVER_ERROR: "Kesalahan server, coba lagi.",
  CANCEL_FAILED: "Pembatalan gagal, hubungi admin.",
};

// ---- Connection ----
function setupConnectionListener() {
  const ref = firebaseDB.ref(".info/connected");
  ref.on("value", (snap) => {
    const banner = document.getElementById("connection-banner");
    if (snap.val() === false) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  });
}

// ---- Balance ----
function setupBalanceListener() {
  if (!currentUser) return;
  balanceListenerRef = firebaseDB.ref("users/" + currentUser.uid + "/balance");
  balanceListenerRef.on("value", (snap) => {
    document.getElementById("balance-display").textContent = formatRupiah(snap.val() || 0);
    document.getElementById("balance-stale").classList.add("hidden");
  }, () => {
    document.getElementById("balance-stale").classList.remove("hidden");
  });
}

// ---- Countries + Stock ----
let countriesData = {};
let stockData = {};

function setupCountriesAndStockListener() {
  firebaseDB.ref("countries").on("value", (snap) => {
    countriesData = snap.val() || {};
    renderCountryList();
  });
  firebaseDB.ref("phone_stocks").on("value", (snap) => {
    stockData = snap.val() || {};
    renderCountryList();
  });
}

function getStockCount(countryKey) {
  let n = 0;
  for (const k in stockData) {
    if (stockData[k].country_key === countryKey && stockData[k].status === "AVAILABLE") n++;
  }
  return n;
}

window.switchTab = function(tab) {
  currentTab = tab;
  const indo = document.getElementById("tab-indo");
  const luar = document.getElementById("tab-luar");
  if (tab === "indo") {
    indo.classList.add("active"); luar.classList.remove("active");
  } else {
    luar.classList.add("active"); indo.classList.remove("active");
  }
  renderCountryList();
};

function renderCountryList() {
  const container = document.getElementById("country-list");
  const entries = Object.entries(countriesData).filter(([, c]) => c.tab === currentTab);
  if (entries.length === 0) {
    container.innerHTML = '<div class="text-center py-12 text-slate-600"><i class="fa-solid fa-box-open text-3xl mb-3 block text-slate-700"></i><p class="text-sm">Belum ada layanan tersedia.</p></div>';
    return;
  }
  container.innerHTML = entries.map(([key, c]) => {
    const stock    = getStockCount(key);
    const disabled = stock === 0;
    const badge = stock === 0
      ? '<span class="badge badge-r">Habis</span>'
      : '<span class="badge badge-g">' + stock + '</span>';
    const btnStyle = disabled
      ? 'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);color:#334155;cursor:not-allowed;border-radius:9px;height:32px;padding:0 12px;font-size:.75rem;font-weight:700;flex-shrink:0;display:inline-flex;align-items:center'
      : 'background:linear-gradient(135deg,#10b981,#059669);color:#fff;border-radius:9px;height:32px;padding:0 12px;font-size:.75rem;font-weight:700;flex-shrink:0;display:inline-flex;align-items:center';
    const btnAttr  = disabled ? " disabled" : ' onclick="buyNokos(\'' + key + '\', \'' + c.country_name.replace(/'/g, "\\'") + '\', ' + c.price + ')"';
    const btnLabel = stock === 0 ? "Habis" : "Beli";
    return '<div class="card" style="padding:12px 14px;display:flex;align-items:center;gap:10px">' +
      '<span style="font-size:1.375rem;line-height:1;flex-shrink:0">' + (c.flag || "\uD83C\uDF0D") + '</span>' +
      '<div style="min-width:0;flex:1">' +
        '<div style="font-size:.875rem;font-weight:700;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + c.country_name + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:2px">' +
          '<span class="tm" style="font-size:.8125rem;color:#34d399">' + formatRupiah(c.price) + '</span>' +
          badge +
        '</div>' +
      '</div>' +
      '<button style="' + btnStyle + '" class="btn"' + btnAttr + '>' + btnLabel + '</button>' +
    '</div>';
  }).join("");
}

// ---- Purchase ----
window.buyNokos = async function(countryKey, countryName, price) {
  hideError();
  const ok = await Dialog.confirm(
    "Konfirmasi Pembelian",
    "Beli <strong style='color:#e2e8f0'>" + countryName + "</strong> seharga <strong style='color:#34d399'>" + formatRupiah(price) + "</strong>?"
  );
  if (!ok) return;
  try {
    const res = await apiFetch("/api/purchase", {
      method: "POST",
      body: JSON.stringify({ country_key: countryKey }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      showError(ERROR_MAP[data.error] || data.message || "Gagal membeli.");
      return;
    }
    showActiveOrder(data.order_id, data.phone_number, data.expires_at, countryName);
  } catch (err) {
    showError("Koneksi bermasalah. Coba lagi.");
  }
};

// ---- Active Order ----
function checkForActiveOrder() {
  if (!currentUser) return;
  firebaseDB.ref("orders").orderByChild("user_id").equalTo(currentUser.uid).once("value", (snap) => {
    if (!snap.exists()) return;
    snap.forEach((child) => {
      const o = child.val();
      if (["WAITING_OTP", "OTP_REQUESTED"].includes(o.status)) {
        showActiveOrder(child.key, o.phone_number, o.expires_at, o.country_name, o.status);
      }
    });
  });
}

let autoOtpTimeout = null;

function showActiveOrder(orderId, phoneNumber, expiresAt, countryName, initialStatus) {
  activeOrderId = orderId;
  document.getElementById("active-phone-number").textContent = phoneNumber;
  const cEl = document.getElementById("active-country"); cEl.textContent = countryName || "";
  document.getElementById("active-order-section").classList.remove("hidden");
  // shop-section tetap tampil agar user bisa beli lagi
  startTimer(expiresAt);
  listenOrder(orderId);
  if (initialStatus === "OTP_REQUESTED") {
    document.getElementById("request-otp-btn").classList.add("hidden");
    document.getElementById("resend-otp-btn").classList.remove("hidden");
  } else {
    // Auto-click Request OTP setelah 30 detik jika user tidak klik
    if (autoOtpTimeout) clearTimeout(autoOtpTimeout);
    const btn = document.getElementById("request-otp-btn");
    btn.disabled = false;
    // Countdown di label tombol
    let cd = 30;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:12px"></i> Request OTP (' + cd + 's)';
    const cdInterval = setInterval(() => {
      cd--;
      if (cd <= 0) {
        clearInterval(cdInterval);
        btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:12px"></i> Request OTP';
      } else {
        btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:12px"></i> Request OTP (' + cd + 's)';
      }
    }, 1000);
    // Kalau user klik duluan, cdInterval ikut berhenti
    btn.addEventListener("click", () => clearInterval(cdInterval), { once: true });
    autoOtpTimeout = setTimeout(() => {
      clearInterval(cdInterval);
      btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:12px"></i> Request OTP';
      doRequestOtp();
    }, 30000);
  }
}

function listenOrder(orderId) {
  if (orderListenerRef) orderListenerRef.off();
  orderListenerRef = firebaseDB.ref("orders/" + orderId);
  orderListenerRef.on("value", (snap) => {
    if (!snap.exists()) return;
    const o = snap.val();
    if (o.otp_code && o.otp_code.length > 0) {
      document.getElementById("otp-code-value").textContent = o.otp_code;
      document.getElementById("otp-code-display").classList.remove("hidden");
    }
    if (o.status === "COMPLETED") {
      clearInterval(timerInterval);
      orderListenerRef.off();
      activeOrderId = null;
      document.getElementById("active-order-section").classList.add("hidden");
      document.getElementById("otp-code-display").classList.add("hidden");
      document.getElementById("success-message").textContent =
        "Nomor " + o.phone_number + " berhasil! Selamat menggunakan WhatsApp baru.";
      document.getElementById("success-modal").classList.remove("hidden");
      renderCountryList();
    }
    if (o.status === "EXPIRED" || o.status === "CANCELLED") {
      clearInterval(timerInterval);
      if (orderListenerRef) orderListenerRef.off();
      activeOrderId = null;
      document.getElementById("active-order-section").classList.add("hidden");
      document.getElementById("timeout-modal").classList.add("hidden");
      document.getElementById("otp-code-display").classList.add("hidden");
      renderCountryList();
    }
  });
}

// ---- Timer ----
function startTimer(expiresAt) {
  clearInterval(timerInterval);
  function tick() {
    const rem = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(rem / 60)).padStart(2, "0");
    const s = String(rem % 60).padStart(2, "0");
    const el = document.getElementById("timer-display");
    if (el) {
      el.textContent = m + ":" + s;
      if (rem <= 60) {
        el.style.color = "#fb7185";
        const pill = document.getElementById('timer-pill');
        if (pill) { pill.style.background = "rgba(244,63,94,.12)"; pill.style.borderColor = "rgba(244,63,94,.25)"; }
      }
    }
    if (rem <= 0) {
      clearInterval(timerInterval);
      document.querySelectorAll("#order-actions button").forEach(b => b.disabled = true);
      document.getElementById("timeout-modal").classList.remove("hidden");
    }
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ---- Cooldown helper ----
function startResendCooldown(seconds) {
  const btn = document.getElementById("resend-otp-btn");
  const sp  = document.getElementById("resend-btn-text");
  btn.disabled = true;
  clearInterval(resendCooldownInterval);
  let cd = seconds;
  function updateLabel() {
    if (sp) sp.textContent = "Kirim Ulang OTP (" + cd + "s)";
  }
  updateLabel();
  resendCooldownInterval = setInterval(() => {
    cd--;
    if (cd <= 0) {
      clearInterval(resendCooldownInterval);
      if (sp) sp.textContent = "Kirim Ulang OTP";
      btn.disabled = false;
    } else {
      updateLabel();
    }
  }, 1000);
}

// ---- OTP Request ----
async function doRequestOtp() {
  const btn = document.getElementById("request-otp-btn");
  if (btn.disabled) return;
  if (autoOtpTimeout) { clearTimeout(autoOtpTimeout); autoOtpTimeout = null; }
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:12px"></i> Memproses...';
  hideError();
  try {
    const res  = await apiFetch("/api/orders/" + activeOrderId + "/request-otp", { method: "POST" });
    const data = await safeJson(res);
    if (!res.ok) {
      showError(data.message || "Gagal meminta OTP.");
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:12px"></i> Request OTP';
      return;
    }
    btn.classList.add("hidden");
    document.getElementById("resend-otp-btn").classList.remove("hidden");
    startResendCooldown(120);
  } catch {
    showError("Koneksi bermasalah.");
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:12px"></i> Request OTP';
  }
}

document.getElementById("request-otp-btn").addEventListener("click", doRequestOtp);

// ---- Resend OTP ----
document.getElementById("resend-otp-btn").addEventListener("click", async () => {
  const btn = document.getElementById("resend-otp-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  hideError();
  try {
    const res  = await apiFetch("/api/orders/" + activeOrderId + "/resend-otp", { method: "POST" });
    const data = await safeJson(res);
    if (!res.ok) {
      showError(data.message || "Gagal kirim ulang OTP.");
      btn.disabled = false;
      return;
    }
    startResendCooldown(120);
  } catch {
    showError("Koneksi bermasalah.");
    btn.disabled = false;
  }
});

// ---- Cancel ----
document.getElementById("cancel-order-btn").addEventListener("click", async () => {
  const btn = document.getElementById("cancel-order-btn");
  btn.disabled = true;
  btn.innerHTML = "<i class=\"fa-solid fa-spinner fa-spin\" style=\"font-size:13px\"></i> Memproses...";
  const resultEl = document.getElementById("cancel-result");
  resultEl.classList.add("hidden");
  try {
    const res = await apiFetch("/api/orders/" + activeOrderId + "/cancel", { method: "POST" });
    const data = await safeJson(res);
    if (!res.ok) {
      resultEl.textContent = data.message || "Pembatalan gagal. Hubungi admin.";
      resultEl.className = "bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-sm mb-4";
      resultEl.classList.remove("hidden");
      btn.disabled = false;
      btn.innerHTML = "<i class=\"fa-solid fa-rotate-left\" style=\"font-size:14px\"></i> Batalkan & Dapatkan Refund";
      return;
    }
    clearInterval(timerInterval);
    activeOrderId = null;
    document.getElementById("timeout-modal").classList.add("hidden");
    document.getElementById("active-order-section").classList.add("hidden");
    document.getElementById("otp-code-display").classList.add("hidden");
    document.getElementById("shop-section").classList.remove("hidden");
    document.getElementById("success-message").textContent =
      "Pesanan dibatalkan. Refund " + formatRupiah(data.refunded_amount) + " dikembalikan ke saldo.";
    document.getElementById("success-modal").classList.remove("hidden");
    renderCountryList();
  } catch {
    resultEl.textContent = "Koneksi bermasalah. Coba lagi.";
    resultEl.className = "bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-sm mb-4";
    resultEl.classList.remove("hidden");
    btn.disabled = false;
    btn.innerHTML = "<i class=\"fa-solid fa-rotate-left\" style=\"font-size:14px\"></i> Batalkan & Dapatkan Refund";
  }
});

// ---- Modals ----
window.closeSuccessModal = function() {
  document.getElementById("success-modal").classList.add("hidden");
};

window.copyPhoneNumber = function() {
  const num = document.getElementById("active-phone-number").textContent;
  navigator.clipboard.writeText(num).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.innerHTML = "<i class=\"fa-solid fa-check\" style=\"font-size:11px\"></i> Disalin!";
    setTimeout(() => { btn.innerHTML = "<i class=\"fa-regular fa-copy\" style=\"font-size:12px\"></i> Salin"; }, 2000);
  });
};


// ══════════════════════════════════════════════════════
// DEPOSIT SYSTEM
// ══════════════════════════════════════════════════════

let currentDeposit = null;
let depositCheckInterval = null;

window.openDepositModal = function() {
  document.getElementById('deposit-modal').classList.remove('hidden');
  document.getElementById('deposit-step-amount').style.display = 'block';
  document.getElementById('deposit-step-method').style.display = 'none';
  document.getElementById('deposit-step-payment').style.display = 'none';
  document.getElementById('deposit-amount-input').value = '';
  selectDepositAmount(null);
};

window.closeDepositModal = function() {
  document.getElementById('deposit-modal').classList.add('hidden');
  if (depositCheckInterval) {
    clearInterval(depositCheckInterval);
    depositCheckInterval = null;
  }
  currentDeposit = null;
};

window.selectDepositAmount = function(amount) {
  const input = document.getElementById('deposit-amount-input');
  if (amount !== null) {
    input.value = amount;
  }
  // Highlight selected chip
  document.querySelectorAll('.deposit-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.amount == input.value);
  });
};

window.proceedToMethod = async function() {
  const amount = parseInt(document.getElementById('deposit-amount-input').value);
  const alertEl = document.getElementById('deposit-amount-alert');
  if (!amount || amount < 10000) {
    const msg = !amount ? 'Masukkan nominal deposit terlebih dahulu.' : 'Minimal deposit adalah Rp 10.000.';
    alertEl.querySelector('span').textContent = msg;
    alertEl.style.display = 'flex';
    document.getElementById('deposit-amount-input').focus();
    return;
  }
  alertEl.style.display = 'none';
  
  document.getElementById('deposit-step-amount').style.display = 'none';
  document.getElementById('deposit-step-method').style.display = 'block';
  document.getElementById('deposit-selected-amount').textContent = formatRupiah(amount);
};

window.backToAmount = function() {
  document.getElementById('deposit-step-method').style.display = 'none';
  document.getElementById('deposit-step-amount').style.display = 'block';
};

window.selectPaymentMethod = async function(method) {
  const amount = parseInt(document.getElementById('deposit-amount-input').value);
  
  try {
    const res = await apiFetch('/api/deposit/create', {
      method: 'POST',
      body: JSON.stringify({ amount, payment_method: method }),
    });
    const data = await safeJson(res);
    
    if (!res.ok) {
      showError(data.message || 'Gagal membuat deposit');
      return;
    }
    
    currentDeposit = data.deposit;
    
    // Show payment instructions
    document.getElementById('deposit-step-method').style.display = 'none';
    document.getElementById('deposit-step-payment').style.display = 'block';
    
    renderPaymentInstructions(data.deposit);
    startDepositStatusCheck(data.deposit.deposit_id);
    
  } catch (err) {
    showError('Koneksi bermasalah: ' + err.message);
  }
};

function renderPaymentInstructions(deposit) {
  const container = document.getElementById('deposit-payment-instructions');
  
  if (deposit.payment_method === 'payment_link') {
    // Payment Link — arahkan ke halaman Pakasir
    container.innerHTML = `
      <div style="text-align:center;padding:16px">
        <div style="font-size:.875rem;color:#64748b;margin-bottom:14px">Klik tombol di bawah untuk melanjutkan pembayaran</div>
        <a href="${deposit.payment_link}" target="_blank" class="btn btn-primary btn-full btn-h">
          <i class="fa-solid fa-external-link" style="font-size:12px"></i> Bayar Sekarang
        </a>
      </div>
    `;
  } else if (deposit.payment_method === 'qris') {
    // QRIS
    container.innerHTML = `
      <div style="text-align:center;padding:16px">
        <div style="font-size:.875rem;color:#64748b;margin-bottom:12px">Scan QRIS dengan aplikasi pembayaran Anda</div>
        <div style="background:#fff;padding:12px;border-radius:14px;display:inline-block;margin-bottom:10px">
          <canvas id="qris-canvas"></canvas>
        </div>
        <div style="font-size:.75rem;color:#94a3b8;margin-bottom:4px">Total Bayar</div>
        <div class="tm" style="font-size:1.125rem;color:#34d399">${formatRupiah(deposit.total_payment)}</div>
        <div style="font-size:.7rem;color:#334155;margin-top:8px">
          <i class="fa-solid fa-clock" style="margin-right:3px"></i>
          Berlaku hingga ${new Date(deposit.expired_at).toLocaleString('id-ID')}
        </div>
      </div>
    `;
    // Generate QR image dari qr_string
    const canvas = document.getElementById('qris-canvas');
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(canvas, deposit.qr_string, {
        width: 220,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      }, err => { if (err) console.error('[QRIS]', err); });
    } else {
      canvas.parentElement.innerHTML = '<div style="color:#ef4444;font-size:.75rem">Gagal load QR library</div>';
    }

  } else {
    // Virtual Account
    const bankName = {
      'bni_va':       'BNI',
      'bri_va':       'BRI',
      'cimb_niaga_va':'CIMB Niaga',
      'danamon_va':   'Danamon',
      'maybank_va':   'Maybank',
      'bnc_va':       'Neo Commerce',
      'bsi_va':       'BSI',
      'muamalat_va':  'Muamalat',
      'ocbc_va':      'OCBC',
    }[deposit.payment_method] || 'Bank';
    
    container.innerHTML = `
      <div style="padding:16px">
        <div style="font-size:.875rem;color:#64748b;margin-bottom:14px;text-align:center">
          Transfer ke Virtual Account ${bankName}
        </div>
        <div style="background:rgba(2,6,23,.6);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
          <div class="tl" style="margin-bottom:6px">Nomor VA</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <span class="tm" style="font-size:1.125rem;color:#f1f5f9">${deposit.va_number}</span>
            <button onclick="copyVA()" class="btn btn-xs btn-sky">
              <i class="fa-regular fa-copy" style="font-size:10px"></i> Salin
            </button>
          </div>
        </div>
        <div style="background:rgba(2,6,23,.6);border:1px solid var(--border);border-radius:10px;padding:14px">
          <div class="tl" style="margin-bottom:6px">Total Transfer</div>
          <div class="tm" style="font-size:1.25rem;color:#34d399">${formatRupiah(deposit.total_payment)}</div>
        </div>
        <div style="font-size:.75rem;color:#334155;margin-top:12px;text-align:center">
          <i class="fa-solid fa-clock" style="margin-right:3px"></i> Berlaku hingga ${new Date(deposit.expired_at).toLocaleString('id-ID')}
        </div>
      </div>
    `;
  }
}

window.copyVA = function() {
  if (!currentDeposit || !currentDeposit.va_number) return;
  navigator.clipboard.writeText(currentDeposit.va_number);
  showSuccessModal('Nomor VA berhasil disalin!');
};

function startDepositStatusCheck(depositId) {
  if (depositCheckInterval) clearInterval(depositCheckInterval);
  
  depositCheckInterval = setInterval(async () => {
    try {
      const res = await apiFetch(`/api/deposit/status/${depositId}`);
      const data = await safeJson(res);
      
      if (data.success && data.deposit.status === 'SUCCESS') {
        clearInterval(depositCheckInterval);
        depositCheckInterval = null;
        closeDepositModal();
        showSuccessModal(`Deposit berhasil! +${formatRupiah(data.deposit.amount)}`);
        // Balance diupdate otomatis oleh Firebase realtime listener
      }
    } catch (err) {
      console.error('[deposit] status check error:', err);
    }
  }, 5000);
}

window.backToMethodSelect = function() {
  document.getElementById('deposit-step-payment').style.display = 'none';
  document.getElementById('deposit-step-method').style.display = 'block';
  if (depositCheckInterval) {
    clearInterval(depositCheckInterval);
    depositCheckInterval = null;
  }
};
