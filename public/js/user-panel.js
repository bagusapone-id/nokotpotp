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
let connectionListenerRef = null;
let countriesListenerRef = null;
let notificationsListenerRef = null;
let stockRefreshTimer = null;
let activeOrdersRefreshTimer = null;
let banListenerRef = null;
let depositEventListenerRef = null;
let depositStatusListenerRef = null;
const referralCodeFromLink = new URLSearchParams(window.location.search).get("ref");
let referralValidationStatus = "empty";
let referralValidationSequence = 0;
let referralValidationTimer = null;
let registrationInProgress = false;
const loginHumanCheck = document.getElementById("login-human-check");
const loginSubmitButton = document.getElementById("login-submit");
const registerHumanCheck = document.getElementById("register-human-check");
const mathChallengeModal = document.getElementById("math-challenge-modal");
const mathChallengeQuestion = document.getElementById("math-challenge-question");
const mathChallengeAnswerInput = document.getElementById("math-challenge-answer");
const mathChallengeError = document.getElementById("math-challenge-error");
let activeHumanCheck = null;
let expectedMathAnswer = 0;
let previousMathQuestion = "";

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateMathChallenge() {
  let question;
  let answer;
  do {
    const operation = randomInteger(0, 1);
    if (operation === 0) {
      const left = randomInteger(2, 20);
      const right = randomInteger(2, 20);
      question = `${left} + ${right} = ?`;
      answer = left + right;
    } else if (operation === 1) {
      const left = randomInteger(5, 30);
      const right = randomInteger(1, left);
      question = `${left} − ${right} = ?`;
      answer = left - right;
    }
  } while (question === previousMathQuestion);

  previousMathQuestion = question;
  expectedMathAnswer = answer;
  mathChallengeQuestion.textContent = question;
  mathChallengeAnswerInput.value = "";
  mathChallengeError.hidden = true;
  mathChallengeError.textContent = "";
}

function openMathChallenge(input) {
  activeHumanCheck = input;
  generateMathChallenge();
  mathChallengeModal.classList.remove("hidden");
  mathChallengeModal.setAttribute("aria-hidden", "false");
  mathChallengeAnswerInput.focus();
}

window.closeMathChallengeModal = function() {
  mathChallengeModal.classList.add("hidden");
  mathChallengeModal.setAttribute("aria-hidden", "true");
  const input = activeHumanCheck;
  activeHumanCheck = null;
  if (input) input.focus();
};

document.getElementById("math-challenge-form").addEventListener("submit", event => {
  event.preventDefault();
  const answer = mathChallengeAnswerInput.value.trim();
  if (!answer) {
    mathChallengeError.textContent = "Isi jawaban terlebih dahulu.";
    mathChallengeError.hidden = false;
    mathChallengeAnswerInput.focus();
    return;
  }

  if (!/^\d+$/.test(answer)) {
    generateMathChallenge();
    mathChallengeError.textContent = "Jawaban salah. Soal baru sudah dibuat.";
    mathChallengeError.hidden = false;
    mathChallengeAnswerInput.focus();
    return;
  }

  if (Number(answer) !== expectedMathAnswer) {
    generateMathChallenge();
    mathChallengeError.textContent = "Jawaban salah. Soal baru sudah dibuat.";
    mathChallengeError.hidden = false;
    mathChallengeAnswerInput.focus();
    return;
  }

  const input = activeHumanCheck;
  if (input) {
    const checkCard = input.closest(".human-check");
    checkCard.classList.add("is-verifying");
    window.closeMathChallengeModal();
    window.setTimeout(() => {
      checkCard.classList.remove("is-verifying");
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, 700);
    return;
  }
  window.closeMathChallengeModal();
});

[loginHumanCheck, registerHumanCheck].forEach(input => {
  input.addEventListener("click", event => {
    if (input.closest(".human-check").classList.contains("is-verifying")) {
      event.preventDefault();
      return;
    }
    if (input.checked) {
      event.preventDefault();
      openMathChallenge(input);
    }
  });
});

function updateLoginSubmitState() {
  loginSubmitButton.disabled = !loginHumanCheck.checked;
  loginHumanCheck.closest(".human-check").classList.toggle("is-checked", loginHumanCheck.checked);
}

if (referralCodeFromLink) {
  document.getElementById("reg-referral-code").value = referralCodeFromLink.trim().toUpperCase();
}

function updateRegisterSubmitState() {
  const submitButton = document.getElementById("register-submit");
  const hasCode = Boolean(document.getElementById("reg-referral-code").value.trim());
  submitButton.disabled = registrationInProgress || !registerHumanCheck.checked ||
    (hasCode && referralValidationStatus !== "valid");
  registerHumanCheck.closest(".human-check").classList.toggle("is-checked", registerHumanCheck.checked);
}

loginHumanCheck.addEventListener("change", updateLoginSubmitState);
registerHumanCheck.addEventListener("change", updateRegisterSubmitState);
updateLoginSubmitState();
updateRegisterSubmitState();

window.validateReferralCodeInput = function() {
  const input = document.getElementById("reg-referral-code");
  const statusEl = document.getElementById("reg-referral-code-status");
  const code = input.value.trim().toUpperCase();
  input.value = code;
  const requestId = ++referralValidationSequence;
  clearTimeout(referralValidationTimer);

  if (!code) {
    referralValidationStatus = "empty";
    statusEl.style.display = "none";
    statusEl.textContent = "";
    updateRegisterSubmitState();
    return;
  }

  if (!/^NOKOTP[A-HJ-NP-Z2-9]{5}$/.test(code)) {
    referralValidationStatus = "invalid";
    statusEl.textContent = "Format kode harus NOKOTP + 5 karakter.";
    statusEl.style.color = "#fb7185";
    statusEl.style.display = "block";
    updateRegisterSubmitState();
    return;
  }

  referralValidationStatus = "checking";
  statusEl.textContent = "Memeriksa kode referral...";
  statusEl.style.color = "#fbbf24";
  statusEl.style.display = "block";
  updateRegisterSubmitState();

  referralValidationTimer = setTimeout(async () => {
    try {
      const response = await fetch("/api/register/validate-referral-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referralCode: code }),
      });
      const data = await safeJson(response);
      if (requestId !== referralValidationSequence) return;
      if (!response.ok) throw new Error(data.message || "Gagal memeriksa kode referral.");

      referralValidationStatus = data.valid ? "valid" : "invalid";
      statusEl.textContent = data.message;
      statusEl.style.color = data.valid ? "#34d399" : "#fb7185";
    } catch (error) {
      if (requestId !== referralValidationSequence) return;
      referralValidationStatus = "invalid";
      statusEl.textContent = error.message || "Gagal memeriksa kode. Coba lagi atau kosongkan kolom.";
      statusEl.style.color = "#fb7185";
    }
    statusEl.style.display = "block";
    updateRegisterSubmitState();
  }, 300);
};

// ---- Auth tab switch ----
window.showAuthTab = function(tab) {
  const loginForm = document.getElementById("login-form");
  const regForm   = document.getElementById("register-form");
  const loginBtn  = document.getElementById("tab-login-btn");
  const regBtn    = document.getElementById("tab-register-btn");
  const authPath = tab === "login" ? "/login" : "/daftar";
  if (window.location.pathname !== authPath) {
    window.history.replaceState(null, "", authPath + window.location.search + window.location.hash);
  }
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
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl    = document.getElementById("auth-error");
  errEl.classList.add("hidden");
  if (!email || !password) {
    errEl.textContent = "Email dan password wajib diisi.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!loginHumanCheck.checked) {
    errEl.textContent = "Centang verifikasi Saya bukan robot terlebih dahulu.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await firebaseAuth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    errEl.textContent = "Login gagal: " + mapAuthError(err.code);
    errEl.classList.remove("hidden");
    loginHumanCheck.checked = false;
    updateLoginSubmitState();
  }
});

// ---- Register ----
document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("reg-username").value.trim();
  const referralCode = document.getElementById("reg-referral-code").value.trim().toUpperCase();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const errEl = document.getElementById("auth-error");
  const successEl = document.getElementById("auth-success");
  errEl.classList.add("hidden");
  successEl.classList.add("hidden");

  if (referralCode && referralValidationStatus !== "valid") {
    errEl.textContent = referralValidationStatus === "checking"
      ? "Tunggu sampai kode referral selesai diperiksa."
      : "Kode referral tidak valid. Hapus atau ganti kode untuk melanjutkan.";
    errEl.classList.remove("hidden");
    window.validateReferralCodeInput();
    return;
  }

  if (!username) {
    errEl.textContent = "Username tidak boleh kosong.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!registerHumanCheck.checked) {
    errEl.textContent = "Centang verifikasi Saya bukan robot terlebih dahulu.";
    errEl.classList.remove("hidden");
    return;
  }

  const submitBtn = document.getElementById("register-submit");
  registrationInProgress = true;
  updateRegisterSubmitState();
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
      body: JSON.stringify({ idToken: token, username: username, referralCode: referralCode }),
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
    registrationInProgress = false;
    registerHumanCheck.checked = false;
    submitBtn.textContent = "Buat Akun";
    updateRegisterSubmitState();
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
    cleanupListeners();
    currentUser = null;
    idToken = null;
    showLoginScreen();
  }
});

firebaseAuth.onIdTokenChanged(async (user) => {
  if (user) idToken = await user.getIdToken();
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  const ok = await Dialog.confirmDanger(
    "Keluar?",
    "Anda akan keluar dari akun ini.",
    "Ya, Keluar"
  );
  if (!ok) return;
  cleanupListeners();
  await firebaseAuth.signOut();
});

// ---- Screens ----
window.logoutBanned = async function() {
  cleanupListeners();
  await firebaseAuth.signOut();
};

window.submitAppeal = async function() {
  const btn = document.getElementById('appeal-btn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:11px"></i> Mengirim...';
  try {
    const res = await apiFetch('/api/user/appeal', { method: 'POST' });
    const data = await safeJson(res);
    if (res.ok) {
      btn.style.display = 'none';
      document.getElementById('appeal-sent-info').style.display = 'block';
    } else {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-flag" style="font-size:11px"></i> Ajukan Banding';
      showError(data.message || 'Gagal mengirim banding.');
    }
  } catch {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-flag" style="font-size:11px"></i> Ajukan Banding';
  }
};

function showSuccessModal(message) {
  document.getElementById("success-message").textContent = message;
  document.getElementById("success-modal").classList.remove("hidden");
}

function showLoginScreen() {
  document.getElementById("splash-screen")?.remove();
  if (typeof window.closeFeaturePromoModal === "function") {
    window.closeFeaturePromoModal();
  }
  // Sembunyikan semua alert DULU
  document.getElementById("auth-error").classList.add("hidden");
  document.getElementById("auth-success").classList.add("hidden");
  // Reset form
  document.getElementById("login-form").reset();
  document.getElementById("register-form").reset();
  updateLoginSubmitState();
  if (referralCodeFromLink) {
    document.getElementById("reg-referral-code").value = referralCodeFromLink.trim().toUpperCase();
  }
  window.validateReferralCodeInput();
  showAuthTab(window.location.pathname === "/daftar" || referralCodeFromLink ? "register" : "login");
  const ls = document.getElementById("login-screen");
  ls.classList.remove("hidden");
  ls.style.display = "flex";
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("app-screen").style.display = "none";
}

function showApp() {
  document.getElementById("splash-screen")?.remove();
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");
  if (window.location.pathname === "/login" || window.location.pathname === "/daftar") {
    window.history.replaceState(null, "", "/");
  }
  initApp();
  openFeaturePromoModal();
}

function openFeaturePromoModal() {
  const modal = document.getElementById("feature-promo-modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("feature-promo-close").focus();
}

window.closeFeaturePromoModal = function() {
  const modal = document.getElementById("feature-promo-modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  // Delay 400ms sebelum buka modal kedua biar tidak kaget
  setTimeout(openAccountPolicyModal, 400);
};

function openAccountPolicyModal() {
  const modal = document.getElementById("account-policy-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

window.closeAccountPolicyModal = function() {
  const modal = document.getElementById("account-policy-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
};

document.addEventListener("keydown", event => {
  const modal = document.getElementById("feature-promo-modal");
  if (event.key === "Escape" && !modal.classList.contains("hidden")) {
    window.closeFeaturePromoModal();
  }
  const policyModal = document.getElementById("account-policy-modal");
  if (event.key === "Escape" && policyModal && !policyModal.classList.contains("hidden")) {
    window.closeAccountPolicyModal();
  }
  if (event.key === "Escape" && !mathChallengeModal.classList.contains("hidden")) {
    window.closeMathChallengeModal();
  }
});

function cleanupListeners() {
  [
    balanceListenerRef,
    connectionListenerRef,
    countriesListenerRef,
    tabsListenerRef,
    notificationsListenerRef,
    banListenerRef,
    depositEventListenerRef,
    depositStatusListenerRef,
  ].forEach(ref => {
    if (ref) ref.off();
  });
  balanceListenerRef = null;
  connectionListenerRef = null;
  countriesListenerRef = null;
  tabsListenerRef = null;
  notificationsListenerRef = null;
  banListenerRef = null;
  depositEventListenerRef = null;
  depositStatusListenerRef = null;
  if (stockRefreshTimer) { clearInterval(stockRefreshTimer); stockRefreshTimer = null; }
  if (activeOrdersRefreshTimer) { clearInterval(activeOrdersRefreshTimer); activeOrdersRefreshTimer = null; }
  if (depositCheckInterval) { clearInterval(depositCheckInterval); depositCheckInterval = null; }
  if (_notifTimer) { clearInterval(_notifTimer); _notifTimer = null; }
  currentDeposit = null;
  // Cleanup semua active orders
  Object.keys(orderStates).forEach(id => removeOrderCard(id));
  clearInterval(timerInterval);
  clearInterval(resendCooldownInterval);
  activeOrderId = null;
}

// ---- Init ----
function initApp() {
  setupConnectionListener();
  setupBalanceListener();
  setupCountriesAndStockListener();
  setupNotificationsListener();
  checkForActiveOrder();
  // Realtime ban listener — auto sign-out if banned
  if (currentUser) {
    banListenerRef = firebaseDB.ref('users/' + currentUser.uid + '/banned');
    banListenerRef.on('value', async (snap) => {
      if (snap.val() === true) {
        // Ambil reason
        const reasonSnap = await firebaseDB.ref('users/' + currentUser.uid + '/ban_reason').once('value');
        const reason = reasonSnap.val() || 'Pelanggaran kebijakan.';
        // Tampilkan modal banned
        document.getElementById('banned-reason').textContent = reason;
        document.getElementById('banned-modal').style.display = 'flex';
      }
    });
  }
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
  if (currentUser) idToken = await currentUser.getIdToken();
  return fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + idToken,
      ...(opts.headers || {}),
    },
  });
}

// Safe JSON parse � returns {} if body is empty or not valid JSON
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
  BANNED: "Akun Anda telah diblokir. Hubungi admin.",
  COUNTRY_OFFLINE: "Stok sedang tidak tersedia.",
};

// ---- Connection ----
function setupConnectionListener() {
  connectionListenerRef = firebaseDB.ref(".info/connected");
  connectionListenerRef.on("value", (snap) => {
    const banner = document.getElementById("connection-banner");
    if (snap.val() === false) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }, error => {
    console.error("[connection] listener error:", error.message);
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
let tabsData = {};
let tabsListenerRef = null;
let stockCounts = {};
let countrySearchQuery = "";
let stockSummaryLoadInProgress = false;
let stockSummaryLastError = "";

function setupCountriesAndStockListener() {
  // Listen to tabs realtime
  tabsListenerRef = firebaseDB.ref("tabs");
  tabsListenerRef.on("value", (snap) => {
    tabsData = snap.val() || {};
    // If no tabs in DB yet, provide defaults so the UI still works
    if (!Object.keys(tabsData).length) {
      tabsData = {
        indo: { name: "Nokos Indo", emoji: "🇮🇩", order: 0 },
        luar: { name: "Nokos Luar", emoji: "🌍", order: 1 },
      };
    }
    renderTabButtons();
    renderCountryList();
  }, error => {
    // Fallback to defaults on error
    if (!Object.keys(tabsData).length) {
      tabsData = {
        indo: { name: "Nokos Indo", emoji: "🇮🇩", order: 0 },
        luar: { name: "Nokos Luar", emoji: "🌍", order: 1 },
      };
      renderTabButtons();
    }
    console.error("[tabs] listener error:", error.message);
  });

  countriesListenerRef = firebaseDB.ref("countries");
  countriesListenerRef.on("value", (snap) => {
    countriesData = snap.val() || {};
    renderCountryList();
  }, error => {
    showError("Gagal memperbarui daftar negara: " + error.message);
  });
  loadStockCounts();
  if (!stockRefreshTimer) {
    stockRefreshTimer = setInterval(() => {
      if (document.visibilityState !== "hidden") loadStockCounts();
    }, 5000);
  }
}

function renderTabButtons() {
  const container = document.getElementById("tab-container");
  if (!container) return;
  const entries = Object.entries(tabsData).sort((a, b) => Number(a[1].order || 0) - Number(b[1].order || 0));
  if (!entries.length) return;

  // If currentTab is not in the new tab list, default to first tab
  if (!tabsData[currentTab]) {
    currentTab = entries[0][0];
  }

  container.innerHTML = entries.map(([id, t]) => {
    const label = (t.emoji ? t.emoji + " " : "") + (t.name || id);
    const isActive = id === currentTab;
    return '<button id="tab-' + id + '" onclick="switchTab(\'' + id.replace(/'/g, "\\'") + '\')" class="seg-tab' + (isActive ? ' active' : '') + '">' + label + '</button>';
  }).join("");
}

async function loadStockCounts() {
  if (!currentUser || stockSummaryLoadInProgress) return;
  stockSummaryLoadInProgress = true;
  try {
    const response = await apiFetch("/api/user/stock-summary");
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.message || "Gagal memuat jumlah stok.");
    const nextCounts = data.available_counts || {};
    if (JSON.stringify(nextCounts) !== JSON.stringify(stockCounts)) {
      stockCounts = nextCounts;
      renderCountryList();
    }
    const errorText = document.getElementById("error-banner-text");
    if (stockSummaryLastError && errorText.textContent === stockSummaryLastError) hideError();
    stockSummaryLastError = "";
  } catch (error) {
    const message = "Gagal memperbarui jumlah stok: " + error.message;
    if (message !== stockSummaryLastError) showError(message);
    stockSummaryLastError = message;
  } finally {
    stockSummaryLoadInProgress = false;
  }
}

function getStockCount(countryKey) {
  return Number(stockCounts[countryKey]) || 0;
}

window.switchTab = function(tab) {
  currentTab = tab;
  // Update active state on dynamically generated buttons
  const container = document.getElementById("tab-container");
  if (container) {
    container.querySelectorAll(".seg-tab").forEach(btn => {
      btn.classList.toggle("active", btn.id === "tab-" + tab);
    });
  }
  countrySearchQuery = "";
  const searchInput = document.getElementById("country-search");
  if (searchInput) searchInput.value = "";
  renderCountryList();
};

window.searchCountries = function(query) {
  countrySearchQuery = query.trim();
  renderCountryList();
};

function normalizeCountrySearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function renderCountryList() {
  const container = document.getElementById("country-list");
  const search = normalizeCountrySearch(countrySearchQuery);
  const entries = Object.entries(countriesData).filter(([key, c]) => {
    if (c.tab !== currentTab) return false;
    if (!search) return true;
    const searchable = normalizeCountrySearch([
      key,
      c.country_name,
      c.flag
    ].join(" "));
    return searchable.includes(search);
  });
  if (entries.length === 0) {
    container.innerHTML = search
      ? '<div style="text-align:center;padding:28px 12px;color:#64748b;font-size:.8125rem"><i class="fa-solid fa-magnifying-glass" style="display:block;font-size:20px;margin-bottom:8px;color:#334155"></i>Negara atau layanan tidak ditemukan.</div>'
      : '<div style="text-align:center;padding:28px 12px;color:#64748b;font-size:.8125rem"><i class="fa-solid fa-box-open" style="display:block;font-size:20px;margin-bottom:8px;color:#334155"></i>Belum ada layanan tersedia.</div>';
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
      if (data.error === 'COUNTRY_OFFLINE') {
        await Dialog.alert("error", "Stok Tidak Tersedia", data.message || "Stok sedang tidak tersedia sementara.");
      } else if (data.error === 'INSUFFICIENT_BALANCE') {
        await Dialog.alert("error", "Saldo Tidak Cukup", data.message || "Saldo kamu tidak mencukupi untuk pembelian ini. Silakan top-up terlebih dahulu.");
      } else {
        await Dialog.alert("error", "Pembelian Gagal", data.message || ERROR_MAP[data.error] || "Gagal membeli.");
      }
      return;
    }
    addActiveOrderCard(data.order_id, data.phone_number, data.expires_at, countryName, undefined, price);
  } catch (err) {
    showError("Koneksi bermasalah. Coba lagi.");
  }
};

// ---- Multi-Order State ----
// Map: orderId ? { listenerRef, timerInterval, cooldownInterval, autoOtpTimeout }
const orderStates = {};

function checkForActiveOrder() {
  if (!currentUser) return;
  loadActiveOrders();
  if (!activeOrdersRefreshTimer) {
    activeOrdersRefreshTimer = setInterval(() => {
      if (document.visibilityState !== "hidden") loadActiveOrders();
    }, 5000);
  }
}

let activeOrdersLoadInProgress = false;

async function loadActiveOrders() {
  if (!currentUser || activeOrdersLoadInProgress) return;
  activeOrdersLoadInProgress = true;
  try {
    const response = await apiFetch("/api/orders/active");
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.message || "Gagal memuat order aktif.");
    const activeIds = new Set();
    Object.entries(data.orders || {}).forEach(([orderId, o]) => {
      if (["WAITING_OTP", "OTP_REQUESTED"].includes(o.status)) {
        activeIds.add(orderId);
        addActiveOrderCard(orderId, o.phone_number, o.expires_at, o.country_name, o.status, o.price);
      } else {
        removeOrderCard(orderId);
      }
    });
    Object.keys(orderStates).forEach(id => {
      if (!activeIds.has(id)) removeOrderCard(id);
    });
  } catch (error) {
    showError("Gagal memperbarui order aktif: " + error.message);
  } finally {
    activeOrdersLoadInProgress = false;
  }
}

function addActiveOrderCard(orderId, phoneNumber, expiresAt, countryName, initialStatus, price) {
  // Jangan duplikat
  if (document.getElementById("order-card-" + orderId)) return;
  const container = document.getElementById("active-orders-container");
  const card = document.createElement("div");
  card.id = "order-card-" + orderId;
  card.className = "card fu";
  card.style.cssText = "padding:14px";
  card.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<div style="min-width:0;flex:1">' +
        '<div style="display:flex;align-items:center;gap:5px;margin-bottom:2px">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block;flex-shrink:0"></span>' +
          '<span class="tl">Order Aktif</span>' +
          (price ? '<span style="font-size:.625rem;font-weight:600;color:#34d399;background:var(--green-dim);border:1px solid var(--green-bdr);padding:1px 6px;border-radius:20px">' + formatRupiah(price) + '</span>' : '') +
        '</div>' +
        '<div style="font-family:\'Geist Mono\',monospace;font-size:.9375rem;font-weight:700;color:#f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + phoneNumber + '</div>' +
        '<div style="font-size:.625rem;color:#475569;margin-top:1px">' + (countryName || "") + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
        '<button onclick="copyOrderNumber(\'' + phoneNumber + '\')" class="btn btn-xs btn-sky"><i class="fa-regular fa-copy" style="font-size:10px"></i></button>' +
        '<div id="timer-pill-' + orderId + '" style="display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:7px;background:var(--amber-dim);border:1px solid var(--amber-bdr)">' +
          '<i class="fa-regular fa-clock" style="font-size:9px;color:var(--amber)"></i>' +
          '<span id="timer-' + orderId + '" class="tm" style="font-size:.8rem;color:var(--amber)">05:00</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    // Kotak OTP � selalu tampil, berubah saat OTP masuk
    '<div id="otp-display-' + orderId + '" style="background:var(--s2);border:1px solid var(--line);border-radius:8px;padding:7px 10px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px">' +
      '<span style="font-size:.5625rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap"><i class="fa-solid fa-key" style="margin-right:3px"></i>OTP</span>' +
      '<span id="otp-val-' + orderId + '" style="font-size:.8125rem;color:#334155;font-style:italic">' +
        '<i class="fa-solid fa-spinner fa-spin" style="font-size:10px;margin-right:4px"></i>Menunggu OTP...' +
      '</span>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:7px">' +
      '<button id="req-btn-" + orderId + "" class="btn btn-sky btn-full" style="height:34px;font-size:.75rem" onclick="doRequestOtpFor(\'' + orderId + '\')">' +
        '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP (30s)' +
      '</button>' +
      '<button id="resend-btn-' + orderId + '" class="btn btn-amber btn-full" style="display:none;height:38px;font-size:.75rem" onclick="doResendOtpFor(\'' + orderId + '\')">' +
        '<i class="fa-solid fa-rotate-right" style="font-size:11px"></i> ' +
        '<span id="resend-txt-' + orderId + '">Kirim Ulang OTP</span>' +
      '</button>' +
      '<button id="cancel-btn-' + orderId + '" class="btn btn-ghost btn-full" style="display:none;height:34px;font-size:.75rem;color:#fb7185" onclick="cancelOrderById(\'' + orderId + '\')">' +
        '<i class="fa-solid fa-rotate-left" style="font-size:10px"></i> Batalkan & Refund' +
      '</button>' +
    '</div>';
  container.appendChild(card);

  // Show wrapper
  const wrapper = document.getElementById("active-orders-wrapper");
  if (wrapper) wrapper.style.display = 'block';

  // Scroll ke card order yang baru
  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  // Init state
  orderStates[orderId] = {
    listenerRef: null,
    timerInterval: null,
    cooldownInterval: null,
    autoOtpTimeout: null,
    hasOtp: false,
    otpRequested: initialStatus === "OTP_REQUESTED",
    resendCount: 0,
  };

  startOrderTimer(orderId, expiresAt);
  listenOrderById(orderId);

  if (initialStatus === "OTP_REQUESTED") {
    document.getElementById("req-btn-" + orderId).style.display = "none";
    document.getElementById("resend-btn-" + orderId).style.display = "flex";
    startResendCooldownFor(orderId, 300);
  } else {
    startAutoOtpCountdown(orderId);
  }
}

window.copyOrderNumber = function(num) {
  navigator.clipboard.writeText(num);
  showSuccessModal("Nomor " + num + " disalin!");
};

function removeOrderCard(orderId) {
  const s = orderStates[orderId];
  if (s) {
    if (s.listenerRef) s.listenerRef.off();
    if (s.timerInterval) clearInterval(s.timerInterval);
    if (s.cooldownInterval) clearInterval(s.cooldownInterval);
    if (s.autoOtpTimeout) clearTimeout(s.autoOtpTimeout);
    delete orderStates[orderId];
  }
  const card = document.getElementById("order-card-" + orderId);
  if (card) card.remove();
  // Sembunyikan wrapper jika tidak ada order lagi
  const container = document.getElementById("active-orders-container");
  const wrapper = document.getElementById("active-orders-wrapper");
  if (wrapper && container && container.children.length === 0) {
    wrapper.style.display = 'none';
  }
}

// ---- Timer per order ----
function startOrderTimer(orderId, expiresAt) {
  const s = orderStates[orderId];
  if (!s) return;
  if (s.timerInterval) clearInterval(s.timerInterval);
  function tick() {
    const rem = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(rem / 60)).padStart(2, "0");
    const sec = String(rem % 60).padStart(2, "0");
    const el = document.getElementById("timer-" + orderId);
    const pill = document.getElementById("timer-pill-" + orderId);
    if (el) el.textContent = m + ":" + sec;
    if (rem <= 60 && el) {
      el.style.color = "#fb7185";
      if (pill) { pill.style.background = "rgba(244,63,94,.12)"; pill.style.borderColor = "rgba(244,63,94,.25)"; }
      // Tampilkan cancel kalau OTP belum masuk
      if (!s.hasOtp) {
        const cancelBtn = document.getElementById("cancel-btn-" + orderId);
        if (cancelBtn) cancelBtn.style.display = "flex";
      }
    }
    if (rem <= 0) {
      clearInterval(s.timerInterval);
      const card = document.getElementById("order-card-" + orderId);
      if (card) {
        card.querySelectorAll("button").forEach(b => {
          if (!b.id.startsWith("cancel-btn-")) b.disabled = true;
        });
      }
      // Tampilkan cancel kalau OTP belum masuk, tombol lebih menonjol
      const cancelBtn = document.getElementById("cancel-btn-" + orderId);
      if (cancelBtn && !s.hasOtp) {
        cancelBtn.style.display = "flex";
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<i class="fa-solid fa-rotate-left" style="font-size:10px"></i> Waktu Habis — Batalkan & Refund';
        cancelBtn.style.background = "rgba(244,63,94,.15)";
        cancelBtn.style.border = "1px solid rgba(244,63,94,.3)";
      } else if (cancelBtn && s.hasOtp) {
        // OTP sudah ada, tetap tampilkan cancel tapi label berbeda
        cancelBtn.style.display = "flex";
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<i class="fa-solid fa-rotate-left" style="font-size:10px"></i> Batalkan & Refund';
      }
    }
  }
  tick();
  s.timerInterval = setInterval(tick, 1000);
}

// ---- Auto OTP countdown per order ----
function startAutoOtpCountdown(orderId) {
  const s = orderStates[orderId];
  if (!s) return;
  const btn = document.getElementById("req-btn-" + orderId);
  if (!btn) return;
  let cd = 30;
  btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP (' + cd + 's)';
  const cdInt = setInterval(() => {
    cd--;
    if (cd <= 0) { clearInterval(cdInt); btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP'; }
    else btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP (' + cd + 's)';
  }, 1000);
  btn.addEventListener("click", () => clearInterval(cdInt), { once: true });
  s.autoOtpTimeout = setTimeout(() => {
    clearInterval(cdInt);
    btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP';
    doRequestOtpFor(orderId);
  }, 30000);
}

// ---- Request OTP per order ----
window.doRequestOtpFor = async function(orderId) {
  const btn = document.getElementById("req-btn-" + orderId);
  const s = orderStates[orderId];
  if (!btn || btn.disabled) return;
  if (s && s.autoOtpTimeout) { clearTimeout(s.autoOtpTimeout); s.autoOtpTimeout = null; }
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:11px"></i> Memproses...';
  try {
    const res = await apiFetch("/api/orders/" + orderId + "/request-otp", { method: "POST" });
    const data = await safeJson(res);
    if (!res.ok) {
      // 409 = sudah OTP_REQUESTED, switch ke resend mode tanpa error
      if (res.status === 409) {
        btn.style.display = "none";
        const resendBtn = document.getElementById("resend-btn-" + orderId);
        if (resendBtn) resendBtn.style.display = "flex";
        startResendCooldownFor(orderId, 300);
        return;
      }
      showError(data.message || "Gagal meminta OTP.");
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP';
      return;
    }
    btn.style.display = "none";
    const resendBtn = document.getElementById("resend-btn-" + orderId);
    if (resendBtn) resendBtn.style.display = "flex";
    startResendCooldownFor(orderId, 300);
  } catch {
    showError("Koneksi bermasalah.");
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i> Request OTP';
  }
};

// ---- Resend OTP per order ----
window.doResendOtpFor = async function(orderId) {
  const btn = document.getElementById("resend-btn-" + orderId);
  const s = orderStates[orderId];
  if (!btn || btn.disabled) return;
  // Maksimal 1x resend
  if (s && s.resendCount >= 1) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-ban" style="font-size:10px"></i> Batas kirim ulang tercapai';
    return;
  }
  btn.disabled = true;
  try {
    const res = await apiFetch("/api/orders/" + orderId + "/resend-otp", { method: "POST" });
    const data = await safeJson(res);
    if (!res.ok) { showError(data.message || "Gagal kirim ulang OTP."); btn.disabled = false; return; }
    if (s) s.resendCount = (s.resendCount || 0) + 1;
    // Setelah 1x resend, disable permanen setelah cooldown habis
    startResendCooldownFor(orderId, 300, true);
  } catch {
    showError("Koneksi bermasalah.");
    btn.disabled = false;
  }
};

// ---- Resend cooldown per order ----
function startResendCooldownFor(orderId, seconds, permanent = false) {
  const s = orderStates[orderId];
  const btn = document.getElementById("resend-btn-" + orderId);
  const sp  = document.getElementById("resend-txt-" + orderId);
  if (!btn) return;
  btn.disabled = true;
  if (s && s.cooldownInterval) clearInterval(s.cooldownInterval);
  let cd = seconds;
  function upd() {
    const m = String(Math.floor(cd / 60)).padStart(2, "0");
    const sec = String(cd % 60).padStart(2, "0");
    if (sp) sp.textContent = "Kirim Ulang OTP (" + m + ":" + sec + ")";
  }
  upd();
  const iv = setInterval(() => {
    cd--;
    if (cd <= 0) {
      clearInterval(iv);
      if (permanent) {
        // Sudah 1x resend, disable permanen
        btn.disabled = true;
        if (sp) sp.textContent = "Batas kirim ulang tercapai";
        btn.style.opacity = "0.4";
        btn.style.cursor = "not-allowed";
      } else {
        if (sp) sp.textContent = "Kirim Ulang OTP";
        btn.disabled = false;
      }
    } else upd();
  }, 1000);
  if (s) s.cooldownInterval = iv;
}

// ---- Listen order by ID ----
function listenOrderById(orderId) {
  const s = orderStates[orderId];
  if (!s) return;
  const ref = firebaseDB.ref("orders/" + orderId);
  s.listenerRef = ref;
  ref.on("value", (snap) => {
    if (!snap.exists()) return;
    const o = snap.val();
    const state = orderStates[orderId];
    if (o.status === "OTP_REQUESTED" && state && !state.otpRequested) {
      state.otpRequested = true;
      if (state.autoOtpTimeout) {
        clearTimeout(state.autoOtpTimeout);
        state.autoOtpTimeout = null;
      }
      const requestButton = document.getElementById("req-btn-" + orderId);
      const resendButton = document.getElementById("resend-btn-" + orderId);
      if (requestButton) requestButton.style.display = "none";
      if (resendButton) {
        resendButton.style.display = "flex";
        startResendCooldownFor(orderId, 300);
      }
    }
    if (state && Number.isSafeInteger(Number(o.resend_count))) {
      state.resendCount = Math.max(state.resendCount, Number(o.resend_count));
    }
    if (o.otp_code && o.otp_code.length > 0) {
      const otpEl = document.getElementById("otp-display-" + orderId);
      const otpVal = document.getElementById("otp-val-" + orderId);
      if (otpEl) {
        otpEl.style.background = "var(--green-dim)";
        otpEl.style.borderColor = "var(--green-bdr)";
        otpEl.querySelector('.tl').style.color = "#34d399";
      }
      if (otpVal) {
        otpVal.style.fontFamily = "'Geist Mono',monospace";
        otpVal.style.fontSize = "1.375rem";
        otpVal.style.color = "#6ee7b7";
        otpVal.style.letterSpacing = ".18em";
        otpVal.style.fontStyle = "normal";
        otpVal.textContent = o.otp_code;
      }
      // Simpan state hasOtp, sembunyikan cancel
      if (orderStates[orderId]) orderStates[orderId].hasOtp = true;
      const cancelBtn = document.getElementById("cancel-btn-" + orderId);
      if (cancelBtn) cancelBtn.style.display = "none";
    }
    if (o.status === "COMPLETED") {
      removeOrderCard(orderId);
      showSuccessModal("Nomor " + o.phone_number + " berhasil! Selamat menggunakan WhatsApp baru.");
      renderCountryList();
    }
    if (o.status === "EXPIRED" || o.status === "CANCELLED") {
      removeOrderCard(orderId);
      renderCountryList();
    }
  });
}

// ---- Cancel (dari timeout modal � ambil order pertama yang ada) ----
function startTimer() {} // stub � tidak dipakai lagi
function listenOrder() {} // stub

// ---- Cancel per order ----
window.cancelOrderById = async function(orderId) {
  const ok = await Dialog.confirmDanger(
    "Batalkan Order?",
    "Order akan dibatalkan dan saldo akan di-refund penuh.",
    "Ya, Batalkan"
  );
  if (!ok) return;
  const btn = document.getElementById("cancel-btn-" + orderId);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:11px"></i>'; }
  try {
    const res = await apiFetch("/api/orders/" + orderId + "/cancel", { method: "POST" });
    const data = await safeJson(res);
    if (!res.ok) {
      if (data.error === 'OTP_RECEIVED') {
        // Sembunyikan tombol cancel karena OTP sudah masuk
        if (btn) btn.style.display = "none";
        await Dialog.alert("error", "Tidak Bisa Dibatalkan", "OTP sudah diterima. Pembatalan hanya bisa dilakukan oleh admin.");
        return;
      }
      showError(data.message || "Pembatalan gagal.");
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Batal'; }
      return;
    }
    removeOrderCard(orderId);
    showSuccessModal("Pesanan dibatalkan. Refund " + formatRupiah(data.refunded_amount) + " dikembalikan ke saldo.");
    renderCountryList();
  } catch {
    showError("Koneksi bermasalah.");
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Batal'; }
  }
};

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


// ------------------------------------------------------
// DEPOSIT SYSTEM
// ------------------------------------------------------

let currentDeposit = null;
let depositCheckInterval = null;
const MIN_DEPOSIT_AMOUNT = 5000;
const MAX_DEPOSIT_AMOUNT = 10000000;
const DELIVERY_DETAILS_THRESHOLD = 1000000;

function getJakartaDate() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

function formatJakartaDate(dateString) {
  const [year, month, day] = dateString.split('-');
  const monthDate = new Date(`${year}-${month}-01T00:00:00+07:00`);
  const monthName = new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    timeZone: 'Asia/Jakarta',
  }).format(monthDate);
  return `${Number(day)} ${monthName} ${year}`;
}

window.openDepositModal = function() {
  document.getElementById('deposit-modal').classList.remove('hidden');
  document.getElementById('deposit-step-amount').style.display = 'block';
  document.getElementById('deposit-step-method').style.display = 'none';
  document.getElementById('deposit-step-payment').style.display = 'none';
  document.getElementById('deposit-amount-input').value = '';
  selectDepositAmount(null);
  updateDepositPreview(0);
  const banner = document.getElementById('deposit-event-banner');
  if (banner && !depositEventListenerRef) {
    depositEventListenerRef = firebaseDB.ref('events/deposit_double');
    depositEventListenerRef.on('value', snap => {
      const ev = snap.val();
      window._depositEventActive = ev && ev.active;
      window._depositEventMin = ev ? (ev.min_amount || 25000) : 25000;
      if (ev && ev.active) banner.style.display = 'block';
      else banner.style.display = 'none';
      updateDepositPreview(parseInt(document.getElementById('deposit-amount-input').value) || 0);
    }, error => {
      console.error('[deposit] event listener error:', error.message);
      window._depositEventActive = false;
      banner.style.display = 'none';
    });
  }
};

window.closeDepositModal = function() {
  document.getElementById('deposit-modal').classList.add('hidden');
  if (depositCheckInterval) {
    clearInterval(depositCheckInterval);
    depositCheckInterval = null;
  }
  if (depositEventListenerRef) {
    depositEventListenerRef.off();
    depositEventListenerRef = null;
  }
  if (depositStatusListenerRef) {
    depositStatusListenerRef.off();
    depositStatusListenerRef = null;
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
  updateDepositPreview(parseInt(input.value) || 0);
  updateDepositDeliveryTerms(parseInt(input.value) || 0);
};

window.onDepositAmountInput = function(val) {
  document.getElementById('deposit-amount-alert').style.display = 'none';
  document.querySelectorAll('.deposit-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.amount == val);
  });
  updateDepositPreview(parseInt(val) || 0);
  updateDepositDeliveryTerms(parseInt(val) || 0);
};

function updateDepositDeliveryTerms(amount) {
  const notice = document.getElementById('deposit-delivery-terms');
  if (!notice) return;
  if (amount > DELIVERY_DETAILS_THRESHOLD) {
    const date = getJakartaDate();
    notice.textContent = `Saldo masuk setelah pembayaran dikonfirmasi. Estimasi: ${formatJakartaDate(date)}.`;
    notice.style.display = 'block';
  } else {
    notice.style.display = 'none';
  }
}

function updateDepositPreview(amount) {
  const preview = document.getElementById('deposit-preview');
  const origEl  = document.getElementById('deposit-preview-orig');
  const finalEl = document.getElementById('deposit-preview-final');
  const badgeEl = document.getElementById('deposit-preview-badge');
  if (!preview || !origEl || !finalEl) return;

  if (!amount || amount < 1) {
    preview.style.display = 'none';
    return;
  }

  const eventActive = window._depositEventActive;
  const eventMin    = window._depositEventMin || 25000;
  const isBonus     = eventActive && amount >= eventMin;

  if (isBonus) {
    origEl.textContent  = formatRupiah(amount);
    origEl.style.display = 'inline';
    finalEl.textContent = formatRupiah(amount * 2);
    if (badgeEl) badgeEl.style.display = 'inline-flex';
  } else {
    origEl.style.display = 'none';
    finalEl.textContent = formatRupiah(amount);
    if (badgeEl) badgeEl.style.display = 'none';
  }
  preview.style.display = 'block';
}

window.proceedToMethod = async function() {
  const amount = parseInt(document.getElementById('deposit-amount-input').value);
  const alertEl = document.getElementById('deposit-amount-alert');
  if (!amount || amount < MIN_DEPOSIT_AMOUNT || amount > MAX_DEPOSIT_AMOUNT) {
    const msg = !amount
      ? 'Masukkan nominal.'
      : amount < MIN_DEPOSIT_AMOUNT
        ? 'Minimal Rp 5.000.'
        : 'Maksimal Rp 10.000.000.';
    alertEl.querySelector('span').textContent = msg;
    alertEl.style.display = 'flex';
    document.getElementById('deposit-amount-input').focus();
    return;
  }
  alertEl.style.display = 'none';
  
  document.getElementById('deposit-step-amount').style.display = 'none';
  document.getElementById('deposit-step-method').style.display = 'block';
  document.getElementById('deposit-selected-amount').textContent = formatRupiah(amount);

  const methodsContainer = document.getElementById('deposit-payment-methods');
  const deliveryNotice = document.getElementById('deposit-method-delivery-terms');
  methodsContainer.textContent = 'Memuat...';
  deliveryNotice.style.display = 'none';
  try {
    const res = await apiFetch(`/api/deposit/methods?amount=${encodeURIComponent(amount)}`);
    const data = await safeJson(res);
    if (!res.ok) {
      methodsContainer.textContent = data.message || 'Gagal memuat metode.';
      return;
    }

    methodsContainer.replaceChildren();
    if (!Array.isArray(data.methods) || data.methods.length === 0) {
      methodsContainer.textContent = 'Metode tidak tersedia.';
      return;
    }

    for (const method of data.methods) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-full';
      button.style.cssText = 'min-height:44px;justify-content:flex-start;padding:8px 14px;text-align:left';

      const icon = document.createElement('i');
      icon.className = method.code === 'qris'
        ? 'fa-solid fa-qrcode'
        : method.code.startsWith('va_')
          ? 'fa-solid fa-building-columns'
          : 'fa-solid fa-mobile-screen-button';
      icon.style.cssText = 'font-size:12px;color:var(--text3);width:18px;flex-shrink:0';

      const name = document.createElement('span');
      name.style.fontWeight = '600';
      name.textContent = method.display_name;
      button.append(icon, name);
      button.addEventListener('click', () => window.selectPaymentMethod(method));
      methodsContainer.append(button);
    }

    if (data.methods.some(method => method.total_amount > DELIVERY_DETAILS_THRESHOLD)) {
      const date = getJakartaDate();
      deliveryNotice.textContent = `Saldo masuk setelah pembayaran dikonfirmasi. Estimasi: ${formatJakartaDate(date)}.`;
      deliveryNotice.style.display = 'block';
    }
  } catch (err) {
    methodsContainer.textContent = 'Gagal memuat metode.';
    console.error('[deposit] payment method loading error:', err.message);
  }
};

window.backToAmount = function() {
  document.getElementById('deposit-step-method').style.display = 'none';
  document.getElementById('deposit-step-amount').style.display = 'block';
};

window.selectPaymentMethod = async function(method) {
  const amount = parseInt(document.getElementById('deposit-amount-input').value);
  if (!method || typeof method.code !== 'string' || !Number.isSafeInteger(method.total_amount)) {
    showError('Metode tidak valid. Muat ulang pilihan.');
    return;
  }

  try {
    const requestBody = {
      amount,
      payment_method: method.code,
      quoted_total: method.total_amount,
    };
    if (method.total_amount > DELIVERY_DETAILS_THRESHOLD) {
      requestBody.delivery_date = getJakartaDate();
      requestBody.delivery_terms_shown = true;
    }
    const res = await apiFetch('/api/deposit/create', {
      method: 'POST',
      body: JSON.stringify(requestBody),
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
  const paymentType = deposit.payment?.type;
  const expiresAt = deposit.expired_at || deposit.expires_at;

  // ── QRIS ──────────────────────────────────────────────────────────────
  if (paymentType === 'qr') {
    const qrString = deposit.payment.qr_string;
    container.innerHTML = `
      <div style="padding:16px">
        <div style="font-size:.8125rem;color:var(--text2);margin-bottom:12px;text-align:center">Scan QRIS untuk membayar</div>
        <div style="background:#fff;padding:12px;border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:12px">
          <canvas id="qris-canvas" style="display:block;max-width:100%;height:auto"></canvas>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;background:var(--s2);border:1px solid var(--line);border-radius:10px;padding:11px 13px;margin-bottom:8px">
          <div>
            <div style="font-size:.5625rem;font-weight:700;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px">Total dibayar</div>
            <div style="font-family:var(--mono);font-size:1rem;font-weight:700;color:var(--g-text)">${formatRupiah(deposit.total_payment || deposit.amount)}</div>
          </div>
        </div>
        <div style="font-size:.7rem;color:var(--text3);text-align:center">
          <i class="fa-solid fa-clock" style="margin-right:3px"></i>
          Berlaku sampai ${new Date(expiresAt).toLocaleString('id-ID')}
        </div>
      </div>
    `;
    const canvas = document.getElementById('qris-canvas');
    if (typeof QRCode !== 'undefined') {
      const size = Math.min(container.offsetWidth - 56, 240);
      QRCode.toCanvas(canvas, qrString, {
        width: size || 220, margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      }, err => { if (err) console.error('[QRIS]', err); });
    } else {
      canvas.parentElement.innerHTML = '<div style="color:var(--rose);font-size:.75rem;padding:16px;text-align:center">Gagal load QR library</div>';
    }

  // ── Virtual Account / Payment Code ────────────────────────────────────
  } else if (paymentType === 'payment_code') {
    const paymentCode = deposit.payment.payment_code;
    const bankDisplay = deposit.payment.display_name || deposit.payment.bank || deposit.gateway_payment_method_name || 'Bank';
    container.innerHTML = `
      <div style="padding:16px">
        <div style="font-size:.8125rem;color:var(--text2);margin-bottom:13px;text-align:center">${bankDisplay} Virtual Account</div>
        <div style="background:var(--s2);border:1px solid var(--line);border-radius:10px;padding:13px;margin-bottom:10px">
          <div style="font-size:.5625rem;font-weight:700;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:7px">Nomor VA</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:var(--mono);font-size:1rem;font-weight:700;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${paymentCode}</span>
            <button onclick="copyVA()" class="btn btn-icon btn-sky" style="flex-shrink:0" title="Salin nomor VA">
              <i class="fa-regular fa-copy" style="font-size:13px"></i>
            </button>
          </div>
        </div>
        <div style="background:var(--s2);border:1px solid var(--line);border-radius:10px;padding:13px;margin-bottom:10px">
          <div style="font-size:.5625rem;font-weight:700;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Total dibayar</div>
          <div style="font-family:var(--mono);font-size:1.25rem;font-weight:700;color:var(--g-text)">${formatRupiah(deposit.total_payment || deposit.amount)}</div>
        </div>
        <div style="font-size:.75rem;color:var(--text3);text-align:center">
          <i class="fa-solid fa-clock" style="margin-right:3px"></i>
          Berlaku sampai ${new Date(expiresAt).toLocaleString('id-ID')}
        </div>
      </div>
    `;

  // ── Redirect (e-wallet) ───────────────────────────────────────────────
  } else if (paymentType === 'redirect') {
    const redirectUrl = deposit.payment.redirect_url;
    container.innerHTML = `
      <div style="text-align:center;padding:16px">
        <div style="font-size:.8125rem;color:var(--text2);margin-bottom:12px">Klik tombol di bawah untuk melanjutkan pembayaran di aplikasi e-wallet.</div>
        <div style="font-size:.75rem;color:var(--text3);margin-bottom:4px">Total dibayar</div>
        <div style="font-family:var(--mono);font-size:1.125rem;font-weight:700;color:var(--g-text);margin-bottom:14px">${formatRupiah(deposit.total_payment || deposit.amount)}</div>
        <a href="${redirectUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-full btn-h" style="text-decoration:none">
          <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:12px"></i> Lanjut ke ${deposit.gateway_payment_method_name || 'E-Wallet'}
        </a>
        <div style="font-size:.7rem;color:var(--text3);margin-top:10px">
          <i class="fa-solid fa-clock" style="margin-right:3px"></i>
          Berlaku sampai ${new Date(expiresAt).toLocaleString('id-ID')}
        </div>
      </div>
    `;

  // ── Fallback ──────────────────────────────────────────────────────────
  } else {
    container.innerHTML = `
      <div style="text-align:center;padding:16px;color:var(--text2);font-size:.8125rem">
        Tipe pembayaran tidak dikenali. Hubungi admin.
      </div>
    `;
  }

  // ── Instruksi cara bayar ──────────────────────────────────────────────
  const instructions = deposit.instructions;
  if (instructions && Array.isArray(instructions.steps) && instructions.steps.length) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:0 16px 16px;font-size:.8125rem;color:var(--text2)';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:6px;color:var(--text)';
    title.textContent = instructions.title || 'Cara pembayaran';
    const steps = document.createElement('ol');
    steps.style.cssText = 'margin:0;padding-left:20px;line-height:1.7';
    instructions.steps.forEach(step => {
      const item = document.createElement('li');
      item.textContent = step;
      steps.appendChild(item);
    });
    wrapper.append(title, steps);
    container.appendChild(wrapper);
  }
}

window.copyVA = function() {
  const paymentCode = currentDeposit?.payment?.payment_code || currentDeposit?.va_number;
  if (!paymentCode) return;
  navigator.clipboard.writeText(paymentCode);
  showSuccessModal('Nomor VA berhasil disalin!');
};

function startDepositStatusCheck(depositId) {
  if (depositCheckInterval) clearInterval(depositCheckInterval);
  if (depositStatusListenerRef) depositStatusListenerRef.off();

  // Primary: Firebase realtime — trigger saat webhook Kasera masuk
  depositStatusListenerRef = firebaseDB.ref('deposits/' + depositId);
  depositStatusListenerRef.on('value', snap => {
    const deposit = snap.val();
    if (deposit && deposit.user_id === currentUser.uid && deposit.status === 'SUCCESS') {
      finishDepositSuccess(depositId, deposit);
    }
  }, error => {
    console.error('[deposit] realtime status listener error:', error.message);
  });

  // Backup: polling ke server setiap 30 detik — hanya jika Firebase listener miss
  // Kasera rate limit: max 1x/detik per transaksi, jadi jangan poll terlalu sering
  depositCheckInterval = setInterval(async () => {
    try {
      const res = await apiFetch(`/api/deposit/status/${depositId}`);
      const data = await safeJson(res);
      if (data.success && data.deposit.status === 'SUCCESS') {
        finishDepositSuccess(depositId, data.deposit);
      }
    } catch (err) {
      console.error('[deposit] status check error:', err);
    }
  }, 30000); // 30 detik — backup saja, Firebase listener yang utama
}

function finishDepositSuccess(depositId, deposit) {
  if (!currentDeposit || currentDeposit.deposit_id !== depositId) return;
  closeDepositModal();
  showSuccessModal(`Deposit berhasil! +${formatRupiah(deposit.amount)}`);
}

window.backToMethodSelect = function() {
  document.getElementById('deposit-step-payment').style.display = 'none';
  document.getElementById('deposit-step-method').style.display = 'block';
  if (depositCheckInterval) {
    clearInterval(depositCheckInterval);
    depositCheckInterval = null;
  }
};

// ------------------------------------------------------
// NOTIFICATIONS
// ------------------------------------------------------

// ══════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════

let _notifItems = [];
let _notifIndex = 0;
let _notifTimer = null;

const _notifTypeCfg = {
  info:    { icon:'fa-circle-info',          color:'#38bdf8', bg:'rgba(14,165,233,.1)',  bdr:'rgba(14,165,233,.2)'  },
  success: { icon:'fa-circle-check',         color:'#34d399', bg:'rgba(16,185,129,.1)',  bdr:'rgba(16,185,129,.2)'  },
  warning: { icon:'fa-triangle-exclamation', color:'#fbbf24', bg:'rgba(245,158,11,.1)',  bdr:'rgba(245,158,11,.2)'  },
};

function renderNotifCarousel() {
  const container = document.getElementById("notif-banners");
  if (!container || !_notifItems.length) {
    if (container) container.innerHTML = "";
    updateScrollPadding();
    return;
  }
  const n   = _notifItems[_notifIndex];
  const cfg = _notifTypeCfg[n.type] || _notifTypeCfg.info;
  const dots = _notifItems.length > 1
    ? '<div style="display:flex;gap:4px;align-items:center;margin-top:6px">' +
        _notifItems.map((_, i) =>
          '<span style="width:'+(i===_notifIndex?'16':'6')+'px;height:6px;border-radius:3px;background:'+(i===_notifIndex?cfg.color:'rgba(255,255,255,.12)')+';transition:width .3s,background .3s"></span>'
        ).join('') +
      '</div>'
    : '';
  container.innerHTML =
    '<div class="fu" style="display:flex;align-items:flex-start;gap:10px;background:'+cfg.bg+';border:1px solid '+cfg.bdr+';border-radius:10px;padding:10px 12px">' +
      '<i class="fa-solid '+cfg.icon+'" style="color:'+cfg.color+';font-size:14px;margin-top:1px;flex-shrink:0"></i>' +
      '<div style="min-width:0;flex:1">' +
        '<div style="font-size:.8125rem;font-weight:700;color:#e2e8f0;margin-bottom:2px">'+n.title+'</div>' +
        '<div style="font-size:.75rem;color:#94a3b8;line-height:1.45">'+n.message+'</div>' +
        dots +
      '</div>' +
    '</div>';
  requestAnimationFrame(updateScrollPadding);
}

function updateScrollPadding() {
  const notifEl = document.getElementById('notif-banners');
  const scrollEl = notifEl?.parentElement;
  if (!scrollEl) return;
  const notifH = notifEl.offsetHeight;
  scrollEl.style.paddingTop = (62 + (notifH > 0 ? notifH + 8 : 0)) + 'px';
  if (notifEl) notifEl.style.top = '62px';
}

function setupNotificationsListener() {
  notificationsListenerRef = firebaseDB.ref("notifications");
  notificationsListenerRef.on("value", (snap) => {
    if (_notifTimer) { clearInterval(_notifTimer); _notifTimer = null; }
    _notifItems = [];
    if (snap.exists()) {
      snap.forEach(c => {
        const val = c.val();
        console.log('[notif] item:', c.key, val);
        _notifItems.push({ id: c.key, ...val });
      });
      _notifItems.sort((a, b) => b.created_at - a.created_at);
    }
    console.log('[notif] total items:', _notifItems.length, _notifItems.map(n=>n.title));
    console.log('[notif] raw snap size:', snap.numChildren());
    _notifIndex = 0;
    renderNotifCarousel();
    if (_notifItems.length > 1) {
      _notifTimer = setInterval(() => {
        _notifIndex = (_notifIndex + 1) % _notifItems.length;
        renderNotifCarousel();
      }, 4000);
    }
  }, error => {
    showError("Gagal memperbarui notifikasi realtime: " + error.message);
  });
}
