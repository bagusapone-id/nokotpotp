// ADMIN PANEL
let adminUser = null, adminToken = null, currentStockTab = "indo";
let stockData = {}, countriesData = {}, ordersData = {};
let countrySearchQueryAdmin = "";
let withdrawalRefreshTimer = null;
let currentAdminTab = "orders";
let withdrawalsLoadInProgress = false;
let usersLoadInProgress = false;
let auditLoadInProgress = false;
let eventStatusLoadInProgress = false;
let ordersLoadInProgress = false;
let stockLoadInProgress = false;
let ordersTimerInterval = null;
let ordersLoaded = false;
let stockLoaded = false;
let ordersLoadError = false;
let stockLoadError = false;
let bulkCancelInProgress = false;

// ── Auth ──
firebaseAuth.onAuthStateChanged(async (user) => {
  if (user) { adminUser = user; adminToken = await user.getIdToken(); await verifyAdmin(); }
  else { adminUser = null; adminToken = null; showLoginScreen(); }
});

async function verifyAdmin() {
  try {
    const res = await adminFetch("/api/admin/verify");
    if (res.ok) showApp();
    else if (res.status === 401 || res.status === 403) {
      showAccessDenied("Akun ini tidak memiliki hak akses admin.");
    } else {
      showAccessDenied("Gagal memverifikasi akses admin. Periksa koneksi lalu coba lagi.");
    }
  } catch {
    showAccessDenied("Tidak dapat terhubung untuk memverifikasi akses admin. Periksa koneksi lalu coba lagi.");
  }
}

function showAccessDenied(message) {
  document.getElementById("splash-screen")?.remove();
  hide("login-screen");
  document.getElementById("access-denied-message").textContent = message;
  show("access-denied", "flex");
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  try {
    await firebaseAuth.signInWithEmailAndPassword(
      document.getElementById("login-email").value.trim(),
      document.getElementById("login-password").value
    );
  } catch (err) {
    errEl.textContent = err.message || "Email atau password salah.";
    errEl.classList.remove("hidden");
  }
});

document.getElementById("logout-btn").addEventListener("click", () => firebaseAuth.signOut());
document.getElementById("access-denied-logout-btn").addEventListener("click", async () => {
  await firebaseAuth.signOut();
});

async function adminFetch(url, opts = {}) {
  if (adminUser) adminToken = await adminUser.getIdToken();
  const response = await fetch(url, { ...opts, headers: { "Content-Type":"application/json", "Authorization":"Bearer "+adminToken, ...(opts.headers||{}) } });
  if (response.headers.get("X-Admin-Audit-Status") === "failed") {
    show("admin-audit-warning");
  }
  return response;
}

async function safeJson(res) {
  const t = await res.text();
  if (!t || !t.trim()) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

function hide(id) { const el=document.getElementById(id); if(el) el.style.display="none"; }
function show(id,d="block") { const el=document.getElementById(id); if(el) el.style.display=d; }

function showLoginScreen() {
  document.getElementById("splash-screen")?.remove();
  show("login-screen","flex"); hide("app-screen");
}

function showApp() {
  document.getElementById("splash-screen")?.remove();
  hide("login-screen"); hide("access-denied"); show("app-screen","flex");
  document.getElementById("admin-username").textContent = adminUser.email;
  initAdmin();
}

function initAdmin() {
  listenOrders();
  listenStock();
  listenCountries();
  listenNotifications();
  listenUsers();
  loadWithdrawals();
  if (!withdrawalRefreshTimer) {
    withdrawalRefreshTimer = setInterval(() => {
      if (!adminUser || document.visibilityState === "hidden") return;
      if (currentAdminTab === "orders") loadOrders();
      if (currentAdminTab === "stock") loadStock();
      if (currentAdminTab === "withdrawals") loadWithdrawals();
      if (currentAdminTab === "notifications") loadEventStatus();
    }, 5000);
  }
}

// ── Nav tabs ──
window.showAdminTab = function(tab) {
  currentAdminTab = tab;
  ["orders","stock","countries","notifications","withdrawals","users","audit"].forEach(t => {
    const el = document.getElementById("tab-"+t);
    if (el) el.style.display = "none";
    const nav = document.getElementById("nav-"+t);
    if (nav) { nav.classList.remove("active"); }
  });
  const tabEl = document.getElementById("tab-"+tab);
  if (tabEl) tabEl.style.display = "block";
  const navEl = document.getElementById("nav-"+tab);
  if (navEl) navEl.classList.add("active");
  if (tab === 'orders') loadOrders();
  if (tab === 'stock') loadStock();
  if (tab === 'users') loadUsers();
  if (tab === 'notifications') loadEventStatus();
  if (tab === 'withdrawals') loadWithdrawals();
  if (tab === 'audit') loadAdminAuditLogs();
};

// ── Orders ──
function listenOrders() {
  loadOrders();
  if (!ordersTimerInterval) ordersTimerInterval = setInterval(() => {
    Object.keys(ordersData).forEach(id => {
      const o = ordersData[id];
      const rem = Math.max(0, Math.floor((o.expires_at - Date.now()) / 1000));
      const m   = String(Math.floor(rem / 60)).padStart(2, "0");
      const s   = String(rem % 60).padStart(2, "0");
      const el  = document.getElementById("timer-" + id);
      if (el) {
        el.textContent = m + ":" + s;
        el.style.color = rem <= 60 ? "#fb7185" : rem <= 120 ? "#fbbf24" : "#34d399";
      }
    });
  }, 1000);
}

async function loadOrders() {
  const container = document.getElementById("order-list");
  if (!adminUser || ordersLoadInProgress) return;
  ordersLoadInProgress = true;
  try {
    const response = await adminFetch("/api/admin/orders");
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.message || "Gagal memuat order aktif.");
    const nextOrders = data.orders || {};
    if (!ordersLoaded || ordersLoadError || JSON.stringify(nextOrders) !== JSON.stringify(ordersData)) {
      ordersData = nextOrders;
      renderOrders();
    }
    ordersLoaded = true;
    ordersLoadError = false;
  } catch (error) {
    container.textContent = "Gagal memperbarui order aktif: " + error.message;
    ordersLoadError = true;
  } finally {
    ordersLoadInProgress = false;
  }
}

function renderOrders() {
  const container = document.getElementById("order-list");
  const entries   = Object.entries(ordersData).slice(0, 200);
  document.getElementById("order-count").textContent = entries.length;
  const activeCount = Object.keys(ordersData).length;
  document.getElementById("active-order-count").textContent = activeCount;
  const bulkCancelButton = document.getElementById("cancel-all-active-btn");
  bulkCancelButton.disabled = activeCount === 0 || bulkCancelInProgress;
  bulkCancelButton.style.opacity = bulkCancelButton.disabled ? ".5" : "1";

  if (!entries.length) {
    container.innerHTML =
      '<div style="text-align:center;padding:48px 0;color:#1e293b">' +
        '<i class="fa-solid fa-inbox" style="font-size:1.75rem;display:block;margin-bottom:10px;color:#0f172a"></i>' +
        '<span style="font-size:.8125rem;color:#334155">Belum ada order aktif.</span>' +
      '</div>';
    return;
  }

  container.innerHTML = entries.map(([id, o]) => {
    const rem   = Math.max(0, Math.floor((o.expires_at - Date.now()) / 1000));
    const m     = String(Math.floor(rem / 60)).padStart(2, "0");
    const s     = String(rem % 60).padStart(2, "0");
    const isOtp    = o.status === "OTP_REQUESTED";
    const isResend = isOtp && (o.resend_count || 0) > 0 && !o.otp_code;
    const tClr     = rem <= 60 ? "#fb7185" : rem <= 120 ? "#fbbf24" : "#34d399";

    const badge = isResend
      ? '<span style="background:rgba(244,63,94,.15);border:1px solid rgba(244,63,94,.3);color:#fb7185;font-size:.6875rem;font-weight:600;padding:2px 8px;border-radius:20px"><i class="fa-solid fa-rotate-right" style="font-size:10px;margin-right:3px"></i>Resend Diminta!</span>'
      : isOtp
        ? '<span style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);color:#fbbf24;font-size:.6875rem;font-weight:600;padding:2px 8px;border-radius:20px"><i class="fa-solid fa-paper-plane" style="font-size:10px;margin-right:3px"></i>OTP Diminta</span>'
        : '<span style="background:rgba(14,165,233,.1);border:1px solid rgba(14,165,233,.2);color:#38bdf8;font-size:.6875rem;font-weight:600;padding:2px 8px;border-radius:20px"><i class="fa-regular fa-clock" style="font-size:10px;margin-right:3px"></i>Menunggu</span>';

    const otpBlock = (isOtp || isResend) ? (
      '<div style="background:rgba(2,6,23,.55);border:1px solid '+(isResend?'rgba(244,63,94,.25)':'rgba(255,255,255,.05)')+';border-radius:10px;padding:12px;margin-top:10px;display:flex;flex-direction:column;gap:8px">' +
        (isResend ? '<div style="font-size:.75rem;color:#fb7185;display:flex;align-items:center;gap:5px;font-weight:600"><i class="fa-solid fa-rotate-right" style="font-size:11px"></i>User minta kirim ulang OTP ('+escapeHtml(o.resend_count)+'x)</div>' : '') +
        '<div id="otp-err-'+escapeHtml(id)+'" style="display:none;color:#fda4af;font-size:.75rem;align-items:center;gap:5px">' +
          '<i class="fa-solid fa-circle-exclamation" style="font-size:11px"></i><span></span>' +
        '</div>' +
        '<div style="display:flex;gap:7px">' +
          '<input type="text" id="otp-inp-'+escapeHtml(id)+'" placeholder="Kode OTP (4-8 digit)" maxlength="8"' +
            ' style="flex:1;background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.09);border-radius:9px;color:#e2e8f0;font-family:\'Geist Mono\',monospace;font-size:.875rem;height:38px;padding:0 10px;outline:none;letter-spacing:.1em"/>' +
          '<button onclick="submitOtp('+htmlJsArg(id)+')"' +
            ' style="background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.25);color:#c084fc;border-radius:9px;height:38px;padding:0 14px;font-size:.8125rem;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px">' +
            '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i>Kirim' +
          '</button>' +
        '</div>' +
        (o.otp_code ? '<div style="font-size:.75rem;color:#34d399;display:flex;align-items:center;gap:5px"><i class="fa-solid fa-circle-check" style="font-size:11px"></i>OTP terkirim: <strong style="font-family:\'Geist Mono\',monospace;letter-spacing:.1em">'+escapeHtml(o.otp_code)+'</strong></div>' : '') +
        '<button onclick="completeOrder('+htmlJsArg(id)+')"' +
          ' style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#34d399;border-radius:9px;height:38px;font-size:.8125rem;font-weight:700;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:6px">' +
          '<i class="fa-solid fa-circle-check" style="font-size:12px"></i> Done / Selesai' +
        '</button>' +
        '<button onclick="adminCancelOrder('+htmlJsArg(id)+')"' +
          ' style="background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.2);color:#fb7185;border-radius:9px;height:34px;font-size:.8125rem;font-weight:600;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:6px">' +
          '<i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Batalkan & Refund' +
        '</button>' +
      '</div>'
    ) : '<div style="margin-top:8px;display:flex;flex-direction:column;gap:7px">' +
        '<div style="font-size:.75rem;color:#334155;font-style:italic">Menunggu user klik minta OTP...</div>' +
        '<button onclick="adminCancelOrder('+htmlJsArg(id)+')"' +
          ' style="background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.2);color:#fb7185;border-radius:9px;height:34px;font-size:.8125rem;font-weight:600;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:6px">' +
          '<i class="fa-solid fa-rotate-left" style="font-size:11px"></i> Batalkan & Refund' +
        '</button>' +
      '</div>';

    return '<div class="card fu" style="padding:12px 14px" id="card-'+escapeHtml(id)+'">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.625rem;color:#1e293b;margin-bottom:3px">'+escapeHtml(id)+'</div>' +
          '<div style="font-size:.875rem;font-weight:700;color:#e2e8f0;margin-bottom:1px">'+escapeHtml(o.username||o.user_id)+'</div>' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.875rem;color:#cbd5e1;margin-bottom:2px">'+escapeHtml(o.phone_number)+'</div>' +
          '<div style="font-size:.6875rem;color:#475569"><i class="fa-solid fa-location-dot" style="font-size:10px;margin-right:3px"></i>'+escapeHtml(o.country_name||o.country_key)+'</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:5px">' +
          badge +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:.875rem;color:'+tClr+';display:flex;align-items:center;gap:4px" id="timer-'+escapeHtml(id)+'">' +
            '<i class="fa-regular fa-clock" style="font-size:10px"></i>'+m+':'+s+
          '</div>' +
          '<div style="font-size:.6875rem;color:#334155"><i class="fa-solid fa-rotate-right" style="font-size:10px;margin-right:2px"></i>Resend: '+escapeHtml(o.resend_count||0)+'x</div>' +
        '</div>' +
      '</div>' +
      otpBlock +
    '</div>';
  }).join("");
}

window.submitOtp = async function(orderId) {
  const inp     = document.getElementById("otp-inp-"+orderId);
  const errWrap = document.getElementById("otp-err-"+orderId);
  const errSpan = errWrap ? errWrap.querySelector("span") : null;
  const val     = inp.value.trim();
  if (errWrap) errWrap.style.display = "none";
  if (!val || !/^\d{4,8}$/.test(val)) {
    if (errSpan) errSpan.textContent = "Kode OTP harus 4-8 digit angka.";
    if (errWrap) errWrap.style.display = "flex";
    return;
  }
  try {
    const res  = await adminFetch("/api/orders/"+orderId+"/submit-otp", { method:"POST", body:JSON.stringify({otp_code:val}) });
    const data = await safeJson(res);
    if (!res.ok) {
      if (errSpan) errSpan.textContent = data.message || "Gagal kirim OTP.";
      if (errWrap) errWrap.style.display = "flex";
    } else {
      inp.style.borderColor = "rgba(16,185,129,.4)";
    }
  } catch {
    if (errSpan) errSpan.textContent = "Koneksi bermasalah.";
    if (errWrap) errWrap.style.display = "flex";
  }
};

window.completeOrder = async function(orderId) {
  const ok = await Dialog.confirmDanger(
    "Tandai Selesai?",
    "Order <strong style='color:#e2e8f0'>"+orderId+"</strong> akan ditandai <strong style='color:#34d399'>COMPLETED</strong>. Pastikan login WhatsApp sudah berhasil.",
    "Ya, Selesai"
  );
  if (!ok) return;
  try {
    const res  = await adminFetch("/api/orders/"+orderId+"/complete", { method:"POST" });
    const data = await safeJson(res);
    if (!res.ok) await Dialog.alert("error","Gagal",data.message||"Gagal menyelesaikan order.");
  } catch { await Dialog.alert("error","Koneksi Bermasalah","Periksa koneksi internet."); }
};

window.adminCancelOrder = async function(orderId) {
  const ok = await Dialog.confirmDanger(
    "Batalkan Order?",
    "Order <strong style='color:#e2e8f0'>"+orderId+"</strong> akan dibatalkan dan saldo user di-refund penuh.",
    "Ya, Batalkan"
  );
  if (!ok) return;
  try {
    const res  = await adminFetch("/api/orders/"+orderId+"/admin-cancel", { method:"POST" });
    const data = await safeJson(res);
    if (!res.ok) await Dialog.alert("error","Gagal Batalkan", data.message||"Gagal membatalkan order.");
    else await Dialog.alert("success","Berhasil","Order dibatalkan dan saldo user sudah di-refund.");
  } catch { await Dialog.alert("error","Koneksi Bermasalah","Periksa koneksi internet."); }
};

window.adminCancelAllActiveOrders = async function() {
  const activeCount = Object.keys(ordersData).length;
  if (!activeCount || bulkCancelInProgress) return;

  const ok = await Dialog.confirmDanger(
    "Batalkan & Refund Semua Order Aktif?",
    "Sebanyak <strong style='color:#fb7185'>"+activeCount+" order aktif</strong> akan dibatalkan. Saldo setiap order yang berhasil diproses akan dikembalikan ke user.",
    "Ya, Refund Semua"
  );
  if (!ok) return;

  bulkCancelInProgress = true;
  renderOrders();
  try {
    const res = await adminFetch("/api/orders/admin-cancel-active", { method:"POST" });
    const data = await safeJson(res);
    if (!res.ok) {
      await Dialog.alert("error", "Gagal", data.message || "Gagal membatalkan order aktif.");
    } else if (data.failed && data.failed.length) {
      await Dialog.alert(
        "error",
        "Sebagian Order Gagal",
        data.cancelled+" order berhasil dibatalkan dan di-refund. "+data.failed.length+" gagal diproses; cek log server sebelum mencoba lagi."
      );
    } else {
      await Dialog.alert(
        "success",
        "Selesai",
        data.cancelled+" order berhasil dibatalkan dan di-refund."+(data.skipped ? " "+data.skipped+" order dilewati karena statusnya sudah berubah." : "")
      );
    }
  } catch {
    await Dialog.alert("error", "Koneksi Bermasalah", "Periksa koneksi internet. Status sebagian order mungkin sudah berubah; muat ulang sebelum mencoba lagi.");
  } finally {
    bulkCancelInProgress = false;
    renderOrders();
  }
};

// ── Stock ──
function listenStock() {
  loadStock();
}

async function loadStock() {
  if (!adminUser || stockLoadInProgress) return;
  stockLoadInProgress = true;
  try {
    const response = await adminFetch("/api/admin/stock");
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.message || "Gagal memuat stok.");
    const nextStock = data.stock || {};
    if (!stockLoaded || stockLoadError || JSON.stringify(nextStock) !== JSON.stringify(stockData)) {
      stockData = nextStock;
      renderStockList(); updateStockCounts(); updateStockFilterCountry();
    }
    stockLoaded = true;
    stockLoadError = false;
  } catch (error) {
    document.getElementById("stock-list").textContent = "Gagal memperbarui stok: " + error.message;
    stockLoadError = true;
  } finally {
    stockLoadInProgress = false;
  }
}

function updateStockCounts() {
  let a=0, l=0;
  for (const k in stockData) { if(stockData[k].status==="AVAILABLE")a++; if(stockData[k].status==="LOCKED")l++; }
  document.getElementById("stock-available-count").textContent = a;
  document.getElementById("stock-locked-count").textContent    = l;
}

function updateStockFilterCountry() {
  const sel = document.getElementById("stock-filter-country");
  const cur = sel.value;
  const keys = [...new Set(Object.values(stockData).map(s=>s.country_key))];
  sel.innerHTML = '<option value="">Semua Negara</option>' +
    keys.map(k => { const c=countriesData[k]; return '<option value="'+escapeHtml(k)+'"'+(cur===k?" selected":"")+'>'+(c?escapeHtml((c.flag||"")+" "+c.country_name):escapeHtml(k))+'</option>'; }).join("");
}

window.renderStockList = function() {
  const container = document.getElementById("stock-list");
  const fc = document.getElementById("stock-filter-country").value;
  const fs = document.getElementById("stock-filter-status").value;
  const entries = Object.entries(stockData).filter(([,s]) => {
    if (fc && s.country_key !== fc) return false;
    if (fs && s.status !== fs) return false;
    return true;
  });
  if (!entries.length) {
    container.innerHTML = '<div style="text-align:center;padding:28px 0;color:#334155;font-size:.8125rem">Tidak ada stok.</div>';
    return;
  }
  const sClr = { AVAILABLE:"s-avail", LOCKED:"s-lock", BURNED:"s-burn", EXPIRED:"s-exp" };
  container.innerHTML = entries.map(([stockId,s]) => {
    const c = countriesData[s.country_key];
    const locked = s.status === "LOCKED";
    const safeStockId = escapeHtml(stockId);
    const attrs = locked
      ? 'title="Terkunci dalam order aktif"'
      : 'onmousedown="startLongPress(\'stock\','+htmlJsArg(stockId)+')" onmouseup="cancelLongPress()" onmouseleave="cancelLongPress()" ontouchstart="startLongPress(\'stock\','+htmlJsArg(stockId)+')" ontouchend="cancelLongPress()" ontouchcancel="cancelLongPress()"';
    return '<div id="si-'+safeStockId+'" '+attrs+' style="display:flex;align-items:center;gap:8px;background:rgba(2,6,23,.55);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:7px 10px;cursor:'+(locked?'default':'pointer')+';user-select:none;-webkit-user-select:none;position:relative;overflow:hidden">' +
      '<div id="lp-'+safeStockId+'" style="position:absolute;left:0;top:0;height:100%;width:0;background:rgba(244,63,94,.12);transition:width 0.5s linear;pointer-events:none"></div>' +
      '<span style="font-size:1rem;line-height:1;flex-shrink:0;position:relative">'+escapeHtml(c?c.flag||"":"")+'</span>' +
      '<span style="font-family:\'Geist Mono\',monospace;font-size:.75rem;color:#94a3b8;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;position:relative">'+escapeHtml(s.number)+'</span>' +
      '<span class="'+(sClr[s.status]||"s-exp")+'" style="font-size:.625rem;font-weight:600;padding:2px 7px;border-radius:20px;flex-shrink:0;position:relative">'+escapeHtml(s.status)+'</span>' +
    '</div>';
  }).join("");
};

// ── Stock tab toggle ──
window.selectStockTab = function(tab) {
  currentStockTab = tab;
  const indo = document.getElementById("stock-tab-indo");
  const luar = document.getElementById("stock-tab-luar");
  if (indo) indo.classList.toggle("active", tab==="indo");
  if (luar) luar.classList.toggle("active", tab==="luar");
  populateCountrySelect();
};

function populateCountrySelect() {
  const sel = document.getElementById("stock-country");
  const filtered = Object.entries(countriesData).filter(([,c]) => c.tab === currentStockTab);
  sel.innerHTML = '<option value="">Pilih negara...</option>' +
    filtered.map(([k,c]) => '<option value="'+escapeHtml(k)+'">'+escapeHtml((c.flag||"")+" "+c.country_name+" — "+formatRupiah(c.price))+'</option>').join("");
}

document.getElementById("stock-numbers").addEventListener("input", function() {
  const n = this.value.split("\n").map(l=>l.trim()).filter(l=>l.length>0).length;
  document.getElementById("stock-preview-count").textContent = n + " nomor";
});

document.getElementById("stock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const countryKey = document.getElementById("stock-country").value;
  const rawText    = document.getElementById("stock-numbers").value;
  const errEl      = document.getElementById("stock-error");
  const succEl     = document.getElementById("stock-success");
  errEl.classList.add("hidden"); succEl.classList.add("hidden");
  if (!countryKey) { errEl.textContent="Pilih negara terlebih dahulu."; errEl.classList.remove("hidden"); return; }
  const numbers = rawText.split("\n").map(l=>l.trim()).filter(l=>l.length>0);
  if (!numbers.length) { errEl.textContent="Masukkan minimal 1 nomor."; errEl.classList.remove("hidden"); return; }
  const sb = e.target.querySelector("button[type=submit]");
  sb.disabled=true; sb.innerHTML='<i class="fa-solid fa-spinner fa-spin" style="font-size:12px"></i> Menyimpan '+numbers.length+' nomor...';
  try {
    const res  = await adminFetch("/api/admin/stock/bulk", { method:"POST", body:JSON.stringify({country_key:countryKey,numbers}) });
    const data = await safeJson(res);
    if (!res.ok) { errEl.textContent=data.message||"Gagal menyimpan stok."; errEl.classList.remove("hidden"); }
    else {
      succEl.textContent=data.added+" nomor ditambahkan"+(data.skipped>0?", "+data.skipped+" duplikat dilewati.":".");
      succEl.classList.remove("hidden");
      document.getElementById("stock-numbers").value="";
      document.getElementById("stock-preview-count").textContent="0 nomor";
    }
  } catch { errEl.textContent="Koneksi bermasalah."; errEl.classList.remove("hidden"); }
  finally { sb.disabled=false; sb.innerHTML='<i class="fa-solid fa-floppy-disk" style="font-size:12px"></i> Simpan Stok'; }
});

// ── Countries ──
function listenCountries() {
  firebaseDB.ref("countries").on("value", (snap) => {
    countriesData = snap.val() || {};
    renderCountriesList(); populateCountrySelect();
  }, error => {
    document.getElementById("countries-list").textContent = "Gagal memuat negara realtime: " + error.message;
  });
}

window.searchCountriesAdmin = function(query) {
  countrySearchQueryAdmin = query.trim();
  renderCountriesList();
};

function normalizeCountrySearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function renderCountriesList() {
  const c = document.getElementById("countries-list");
  const search = normalizeCountrySearch(countrySearchQueryAdmin);
  const entries = Object.entries(countriesData).filter(([key, value]) => {
    if (!search) return true;
    return normalizeCountrySearch([
      key,
      value.country_name,
      value.flag,
      value.tab
    ].join(" ")).includes(search);
  });
  if (!entries.length) {
    c.innerHTML = search
      ? '<div style="text-align:center;padding:28px 0;color:#334155;font-size:.8125rem"><i class="fa-solid fa-magnifying-glass" style="display:block;font-size:18px;margin-bottom:8px"></i>Negara tidak ditemukan.</div>'
      : '<div style="text-align:center;padding:28px 0;color:#334155;font-size:.8125rem">Belum ada negara.</div>';
    return;
  }
  c.innerHTML = entries.map(([k,v]) => {
    const avail = Object.values(stockData).filter(s=>s.country_key===k&&s.status==="AVAILABLE").length;
    const isOffline = v.offline === true;
    const tb = v.tab==="indo"
      ? '<span style="background:rgba(16,185,129,.1);color:#34d399;border:1px solid rgba(16,185,129,.18);font-size:.625rem;font-weight:600;padding:1px 6px;border-radius:20px">Indo</span>'
      : '<span style="background:rgba(14,165,233,.1);color:#38bdf8;border:1px solid rgba(14,165,233,.18);font-size:.625rem;font-weight:600;padding:1px 6px;border-radius:20px">Luar</span>';
    const offlineBadge = isOffline
      ? '<span style="background:rgba(244,63,94,.12);color:#fb7185;border:1px solid rgba(244,63,94,.2);font-size:.625rem;font-weight:600;padding:1px 6px;border-radius:20px"><i class="fa-solid fa-power-off" style="font-size:9px;margin-right:2px"></i>Offline</span>'
      : '';
    const toggleBtn = isOffline
      ? '<button onclick="event.stopPropagation();toggleCountryOffline('+htmlJsArg(k)+',false)" style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#34d399;border-radius:7px;height:28px;padding:0 10px;font-size:.6875rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0" title="Online-kan"><i class="fa-solid fa-power-off" style="font-size:9px;margin-right:3px"></i>Online-kan</button>'
      : '<button onclick="event.stopPropagation();toggleCountryOffline('+htmlJsArg(k)+',true)" style="background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.18);color:#fb7185;border-radius:7px;height:28px;padding:0 10px;font-size:.6875rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0" title="Offline-kan"><i class="fa-solid fa-power-off" style="font-size:9px;margin-right:3px"></i>Offline-kan</button>';
    return '<div id="ci-'+escapeHtml(k)+'" onmousedown="startLongPress(\'country\','+htmlJsArg(k)+')" onmouseup="cancelLongPress()" onmouseleave="cancelLongPress()" ontouchstart="startLongPress(\'country\','+htmlJsArg(k)+')" ontouchend="cancelLongPress()" ontouchcancel="cancelLongPress()" style="display:flex;align-items:center;justify-content:space-between;background:'+(isOffline?'rgba(244,63,94,.05)':'rgba(2,6,23,.55)')+';border:1px solid '+(isOffline?'rgba(244,63,94,.15)':'rgba(255,255,255,.05)')+';border-radius:10px;padding:10px 12px;gap:10px;cursor:pointer;user-select:none;-webkit-user-select:none;position:relative;overflow:hidden">' +
    '<div id="lp-'+escapeHtml(k)+'" style="position:absolute;left:0;top:0;height:100%;width:0;background:rgba(244,63,94,.12);transition:width 0.5s linear;pointer-events:none"></div>' +
      '<div style="display:flex;align-items:center;gap:10px;min-width:0;position:relative">' +
        '<span style="font-size:1.375rem;line-height:1;flex-shrink:0;opacity:'+(isOffline?'.4':'1')+'">'+escapeHtml(v.flag||"")+'</span>' +
        '<div style="min-width:0">' +
          '<div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;flex-wrap:wrap">' +
            '<span style="font-size:.875rem;font-weight:700;color:'+(isOffline?'#64748b':'#e2e8f0')+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHtml(v.country_name)+'</span>'+tb+offlineBadge+
          '</div>' +
          '<span style="font-family:\'Geist Mono\',monospace;font-size:.625rem;color:#334155">'+escapeHtml(k)+'</span>' +
          (isOffline && v.offline_reason ? '<div style="font-size:.625rem;color:#ef4444;margin-top:2px"><i class="fa-solid fa-circle-info" style="font-size:9px;margin-right:2px"></i>'+escapeHtml(v.offline_reason)+'</div>' : '') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;position:relative">' +
        '<div style="text-align:right">' +
          '<div style="font-family:\'Geist Mono\',monospace;font-weight:700;font-size:.875rem;color:#34d399">'+formatRupiah(v.price)+'</div>' +
          '<div style="font-size:.6875rem;color:#334155;margin-top:1px"><i class="fa-solid fa-layer-group" style="font-size:10px;margin-right:2px"></i>'+avail+' tersedia</div>' +
        '</div>' +
        toggleBtn +
      '</div>' +
    '</div>';
  }).join("");
}

document.getElementById("country-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tab=document.getElementById("c-tab").value;
  const name=document.getElementById("c-name").value.trim();
  const flag=document.getElementById("c-flag").value.trim();
  const price=parseInt(document.getElementById("c-price").value);
  const key=document.getElementById("c-key").value.trim().toLowerCase().replace(/\s+/g,"_");
  const errEl=document.getElementById("country-error"), succEl=document.getElementById("country-success");
  errEl.classList.add("hidden"); succEl.classList.add("hidden");
  if(!key||!name||isNaN(price)){errEl.textContent="Semua field wajib diisi.";errEl.classList.remove("hidden");return;}
  if(!/^[a-z0-9_]+$/.test(key)){errEl.textContent="ID Key hanya huruf kecil, angka, underscore.";errEl.classList.remove("hidden");return;}
  const sb=e.target.querySelector("button[type=submit]");
  sb.disabled=true; sb.innerHTML='<i class="fa-solid fa-spinner fa-spin" style="font-size:12px"></i> Menyimpan...';
  try {
    const res=await adminFetch("/api/admin/country",{method:"POST",body:JSON.stringify({key,tab,country_name:name,flag,price})});
    const data=await safeJson(res);
    if(!res.ok){errEl.textContent=data.message||"Gagal.";errEl.classList.remove("hidden");}
    else{succEl.textContent="Negara "+name+" berhasil ditambahkan!";succEl.classList.remove("hidden");e.target.reset();}
  } catch{errEl.textContent="Koneksi bermasalah.";errEl.classList.remove("hidden");}
  finally{sb.disabled=false;sb.innerHTML='<i class="fa-solid fa-floppy-disk" style="font-size:12px"></i> Simpan Negara';}
});

function formatRupiah(n) { return "Rp " + Number(n||0).toLocaleString("id-ID"); }

async function loadWithdrawals() {
  const container = document.getElementById("withdrawal-list");
  if (!container || withdrawalsLoadInProgress) return;
  withdrawalsLoadInProgress = true;
  try {
    const res = await adminFetch("/api/admin/withdrawals");
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.message || "Gagal memuat penarikan.");
    renderWithdrawals(Array.isArray(data.withdrawals) ? data.withdrawals : []);
  } catch (err) {
    document.getElementById("withdrawal-count").textContent = "!";
    container.textContent = err.message || "Gagal memuat permintaan penarikan.";
  } finally {
    withdrawalsLoadInProgress = false;
  }
}

function renderWithdrawals(withdrawals) {
  const container = document.getElementById("withdrawal-list");
  const pendingCount = withdrawals.filter(item => item.status === "PENDING" || item.status === "REJECTING").length;
  document.getElementById("withdrawal-count").textContent = String(pendingCount);
  withdrawals.sort((a, b) => {
    const statusOrder = item => item.status === "PENDING" || item.status === "REJECTING" ? 0 : 1;
    return statusOrder(a) - statusOrder(b) || Number(b.created_at || 0) - Number(a.created_at || 0);
  });

  if (!withdrawals.length) {
    container.innerHTML = '<div class="card" style="padding:24px;text-align:center;color:#64748b;font-size:.8125rem">Belum ada permintaan penarikan.</div>';
    return;
  }

  const statusLabels = {
    PROCESSING: ["Memproses", "#fbbf24"],
    PENDING: ["Menunggu", "#fbbf24"],
    COMPLETED: ["Selesai", "#34d399"],
    REJECTING: ["Refund diproses", "#fbbf24"],
    REJECTED: ["Ditolak &amp; direfund", "#fb7185"],
  };
  container.innerHTML = withdrawals.map(item => {
    const [statusText, statusColor] = statusLabels[item.status] || ["Status tidak diketahui", "#94a3b8"];
    const pending = item.status === "PENDING";
    const rejecting = item.status === "REJECTING";
    const actions = pending
      ? '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button class="btn btn-primary btn-sm" data-action="complete" data-uid="' + escapeHtml(item.user_id) + '" data-id="' + escapeHtml(item.withdrawal_id) + '" data-amount="' + Number(item.amount || 0) + '" style="flex:1"><i class="fa-solid fa-check"></i> Selesai dibayar</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="reject" data-uid="' + escapeHtml(item.user_id) + '" data-id="' + escapeHtml(item.withdrawal_id) + '" data-amount="' + Number(item.amount || 0) + '" style="flex:1;color:#fb7185"><i class="fa-solid fa-xmark"></i> Tolak &amp; refund</button>' +
        '</div>'
      : rejecting
        ? '<button class="btn btn-amber btn-sm" data-action="reject" data-uid="' + escapeHtml(item.user_id) + '" data-id="' + escapeHtml(item.withdrawal_id) + '" data-amount="' + Number(item.amount || 0) + '" style="margin-top:12px"><i class="fa-solid fa-rotate-right"></i> Lanjutkan refund</button>'
        : "";
    return '<div class="card" style="padding:14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px">' +
        '<div><div style="font-size:.875rem;font-weight:700;color:#e2e8f0">' + escapeHtml(item.username) + '</div>' +
        '<div style="font-size:.6875rem;color:#64748b;margin-top:3px">' + escapeHtml(formatWithdrawalDate(item.created_at)) + '</div></div>' +
        '<span style="font-size:.6875rem;font-weight:700;color:' + statusColor + ';white-space:nowrap">' + statusText + '</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.75rem">' +
        '<div><div style="color:#64748b">Nominal</div><strong style="color:#34d399">' + escapeHtml(formatRupiah(item.amount)) + '</strong></div>' +
        '<div><div style="color:#64748b">Bank / e-wallet</div><strong style="color:#e2e8f0">' + escapeHtml(item.bank) + '</strong></div>' +
        '<div><div style="color:#64748b">Nomor rekening</div><strong style="color:#e2e8f0;font-family:monospace">' + escapeHtml(item.account_number) + '</strong></div>' +
        '<div><div style="color:#64748b">Biaya</div><strong style="color:#e2e8f0">Gratis</strong></div>' +
      '</div>' + actions +
    '</div>';
  }).join("");

  container.onclick = event => {
    const button = event.target.closest("button[data-action]");
    if (button) processWithdrawal(button.dataset.uid, button.dataset.id, button.dataset.action, button.dataset.amount);
  };
}

window.processWithdrawal = async function(uid, withdrawalId, action, amount) {
  const amountText = formatRupiah(amount);
  const complete = action === "complete";
  const confirmed = complete
    ? await Dialog.confirm("Konfirmasi penarikan?", "Pastikan transfer sebesar <strong style=\"color:#34d399\">" + amountText + "</strong> sudah dilakukan ke rekening tujuan.")
    : await Dialog.confirmDanger("Tolak penarikan?", "Saldo sebesar <strong style=\"color:#34d399\">" + amountText + "</strong> akan dikembalikan ke akun user.", "Ya, Tolak & Refund");
  if (!confirmed) return;

  try {
    const res = await adminFetch("/api/admin/withdrawals/" + encodeURIComponent(uid) + "/" + encodeURIComponent(withdrawalId) + "/" + action, {
      method: "POST",
    });
    const data = await safeJson(res);
    if (!res.ok) {
      await Dialog.alert("error", "Gagal", data.message || "Permintaan tidak dapat diproses.");
      return;
    }
    await loadWithdrawals();
    await Dialog.alert("success", "Berhasil", data.message || "Status penarikan diperbarui.");
  } catch {
    await Dialog.alert("error", "Koneksi Bermasalah", "Periksa koneksi internet.");
  }
};

window.loadAdminAuditLogs = async function() {
  const container = document.getElementById("admin-audit-list");
  if (!container || auditLoadInProgress) return;
  auditLoadInProgress = true;
  try {
    const res = await adminFetch("/api/admin/audit-logs");
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.message || "Gagal memuat audit log.");
    const logs = Array.isArray(data.logs) ? data.logs : [];
    if (!logs.length) {
      container.innerHTML = '<div style="text-align:center;padding:24px;color:#64748b;font-size:.8125rem">Belum ada aktivitas admin tercatat.</div>';
      return;
    }

    container.innerHTML = logs.map(log => {
      const succeeded = log.outcome === "SUCCESS";
      const date = new Date(Number(log.created_at));
      const timestamp = Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("id-ID");
      const details = Object.entries(log.details || {})
        .map(([key, value]) => escapeHtml(key) + ": " + escapeHtml(value))
        .join(" · ");
      return '<div style="background:rgba(2,6,23,.55);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:11px 12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">' +
          '<div style="font-size:.8125rem;font-weight:700;color:#e2e8f0;overflow-wrap:anywhere">' + escapeHtml(log.action) + '</div>' +
          '<span style="font-size:.625rem;font-weight:700;color:' + (succeeded ? '#34d399' : '#fbbf24') + ';white-space:nowrap">' +
            escapeHtml(log.outcome || "UNKNOWN") + ' · ' + escapeHtml(log.status_code) +
          '</span>' +
        '</div>' +
        '<div style="font-size:.6875rem;color:#64748b;margin-top:5px;overflow-wrap:anywhere">Admin: ' + escapeHtml(log.admin_uid) +
          (log.target_id ? ' · Target: ' + escapeHtml(log.target_id) : '') +
        '</div>' +
        (details ? '<div style="font-size:.6875rem;color:#94a3b8;margin-top:4px;overflow-wrap:anywhere">' + details + '</div>' : '') +
        '<div style="font-size:.625rem;color:#475569;margin-top:5px">' + escapeHtml(timestamp) + '</div>' +
      '</div>';
    }).join("");
  } catch (error) {
    container.textContent = error.message || "Gagal memuat audit log.";
  } finally {
    auditLoadInProgress = false;
  }
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function htmlJsArg(value) {
  return escapeHtml(JSON.stringify(String(value)));
}

function formatWithdrawalDate(timestamp) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("id-ID");
}

// ── Delete Stock ──
window.deleteStock = async function(stockId) {
  const stock = stockData[stockId];
  if (!stock) return;
  const ok = await Dialog.confirmDanger(
    "Hapus Stok?",
    "Nomor <strong style='color:#e2e8f0;font-family:\"JetBrains Mono\",monospace'>"+escapeHtml(stock.number)+"</strong> akan dihapus permanen.",
    "Ya, Hapus"
  );
  if (!ok) return;
  try {
    const res = await adminFetch("/api/admin/stock/"+stockId, { method:"DELETE" });
    const data = await safeJson(res);
    if (!res.ok) {
      await Dialog.alert("error","Gagal Hapus",data.message||"Tidak bisa menghapus stok.");
    }
  } catch {
    await Dialog.alert("error","Koneksi Bermasalah","Periksa koneksi internet.");
  }
};

// ── Toggle Country Offline ──
window.toggleCountryOffline = async function(key, goOffline) {
  const country = countriesData[key];
  if (!country) return;
  if (goOffline) {
    // Minta reason
    const ok = await Dialog.confirmDanger(
      "Offline-kan Negara?",
      '<div style="margin-bottom:8px">Negara <strong style="color:#e2e8f0">'+escapeHtml((country.flag||"")+" "+country.country_name)+'</strong> tidak bisa dibeli user.</div>' +
      '<textarea id="offline-reason-input" placeholder="Alasan (contoh: Sedang maintenance, stok habis sementara...)" style="width:100%;background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#e2e8f0;font-family:inherit;font-size:.8125rem;padding:10px;resize:none;outline:none;height:72px;box-sizing:border-box;margin-top:4px"></textarea>',
      "Ya, Offline-kan"
    );
    if (!ok) return;
    const reason = document.getElementById('offline-reason-input')?.value?.trim() || 'Stok sedang tidak tersedia sementara.';
    try {
      const res = await adminFetch('/api/admin/country/'+encodeURIComponent(key)+'/offline', { method:'POST', body:JSON.stringify({ offline:true, reason }) });
      const data = await safeJson(res);
      if (!res.ok) await Dialog.alert('error','Gagal', data.message||'Gagal offline-kan negara.');
    } catch { await Dialog.alert('error','Koneksi Bermasalah','Periksa koneksi internet.'); }
  } else {
    const ok = await Dialog.confirm('Online-kan Negara?', 'Negara <strong style="color:#e2e8f0">'+escapeHtml((country.flag||"")+" "+country.country_name)+'</strong> bisa dibeli kembali oleh user.');
    if (!ok) return;
    try {
      const res = await adminFetch('/api/admin/country/'+encodeURIComponent(key)+'/offline', { method:'POST', body:JSON.stringify({ offline:false }) });
      const data = await safeJson(res);
      if (!res.ok) await Dialog.alert('error','Gagal', data.message||'Gagal online-kan negara.');
    } catch { await Dialog.alert('error','Koneksi Bermasalah','Periksa koneksi internet.'); }
  }
};

// ── Delete Country ──
window.deleteCountry = async function(key) {
  const country = countriesData[key];
  if (!country) {
    await Dialog.alert("error", "Error", "Data negara tidak ditemukan (key: "+escapeHtml(key)+"). Coba refresh halaman.");
    return;
  }
  const avail = Object.values(stockData).filter(s=>s.country_key===key&&['AVAILABLE','LOCKED'].includes(s.status)).length;
  const ok = await Dialog.confirmDanger(
    "Hapus Negara?",
    (avail > 0
      ? "<strong style='color:#fb7185'>⚠️ Masih ada "+avail+" stok aktif!</strong><br><br>"
      : "") +
    "Negara <strong style='color:#e2e8f0'>"+escapeHtml((country.flag||"")+" "+country.country_name)+"</strong> akan dihapus permanen.",
    "Ya, Hapus"
  );
  if (!ok) return;
  try {
    const res  = await adminFetch("/api/admin/country/"+encodeURIComponent(key), { method:"DELETE" });
    const data = await safeJson(res);
    if (!res.ok) {
      await Dialog.alert("error", "Gagal Hapus", data.message || "Tidak bisa menghapus negara.");
    } else {
      await Dialog.alert("success", "Berhasil", "Negara berhasil dihapus.");
    }
  } catch {
    await Dialog.alert("error", "Koneksi Bermasalah", "Periksa koneksi internet.");
  }
};

// ── Long Press to Delete ──
let _lpTimer = null;
let _lpBarEl = null;

window.startLongPress = function(type, id) {
  cancelLongPress();
  const barEl = document.getElementById('lp-' + id);
  if (!barEl) return;
  _lpBarEl = barEl;
  // Animate bar fill over 500ms
  requestAnimationFrame(() => { barEl.style.width = '100%'; });
  _lpTimer = setTimeout(() => {
    _lpBarEl = null;
    if (type === 'stock') deleteStock(id);
    else if (type === 'country') deleteCountry(id);
  }, 500);
};

window.cancelLongPress = function() {
  if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  if (_lpBarEl) { _lpBarEl.style.transition = 'none'; _lpBarEl.style.width = '0'; _lpBarEl = null; }
};

// ── Events ──
async function loadEventStatus() {
  if (eventStatusLoadInProgress) return;
  eventStatusLoadInProgress = true;
  try {
    const res  = await adminFetch('/api/admin/events');
    const data = await safeJson(res);
    const ev = data.events?.deposit_double;
    const badge = document.getElementById('event-status-badge');
    const text  = document.getElementById('event-status-text');
    if (badge && text) {
      if (ev && ev.active) {
        badge.textContent = 'AKTIF';
        badge.style.cssText = 'padding:4px 12px;border-radius:20px;font-size:.75rem;font-weight:700;background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.25);color:#34d399';
        text.textContent = 'Deposit ≥ Rp ' + Number(ev.min_amount||25000).toLocaleString('id-ID') + ' → 2x saldo';
      } else {
        badge.textContent = 'NONAKTIF';
        badge.style.cssText = 'padding:4px 12px;border-radius:20px;font-size:.75rem;font-weight:700;background:rgba(100,116,139,.1);border:1px solid rgba(100,116,139,.2);color:#334155';
        text.textContent = 'Event tidak aktif';
      }
    }
  } catch (error) {
    console.error('[admin-panel] event status refresh failed:', error.message);
  } finally {
    eventStatusLoadInProgress = false;
  }
}

window.toggleEvent = async function(active) {
  const ok = await Dialog.confirm(
    active ? 'Aktifkan Event?' : 'Nonaktifkan Event?',
    active
      ? 'Event deposit 2x akan diaktifkan. Semua user yang deposit ≥ Rp 25.000 mendapat saldo 2x (1x per user).'
      : 'Event deposit 2x akan dinonaktifkan. User tidak akan mendapat bonus.'
  );
  if (!ok) return;
  try {
    const res = await adminFetch('/api/admin/events/deposit_double', {
      method: 'POST',
      body: JSON.stringify({ active, min_amount: 25000 })
    });
    const data = await safeJson(res);
    if (!res.ok) await Dialog.alert('error','Gagal', data.message||'Gagal update event.');
    else { await loadEventStatus(); }
  } catch { await Dialog.alert('error','Koneksi Bermasalah','Periksa koneksi.'); }
};

window.resetEventUsers = async function() {
  const ok = await Dialog.confirmDanger(
    'Reset Event?',
    'Semua user akan bisa mendapat bonus deposit 2x lagi. Gunakan ini saat memulai periode event baru.',
    'Ya, Reset'
  );
  if (!ok) return;
  try {
    const res = await adminFetch('/api/admin/events/deposit_double/reset-users', { method: 'POST' });
    const data = await safeJson(res);
    if (!res.ok) await Dialog.alert('error','Gagal', data.message||'Gagal reset.');
    else await Dialog.alert('success','Berhasil','Event berhasil direset. Semua user bisa dapat bonus lagi.');
  } catch { await Dialog.alert('error','Koneksi Bermasalah','Periksa koneksi.'); }
};

// ── Notifications ──
let notificationsData = {};

function listenNotifications() {
  firebaseDB.ref("notifications").on("value", (snap) => {
    notificationsData = snap.val() || {};
    renderNotifList();
  }, error => {
    document.getElementById("notif-list").textContent = "Gagal memuat notifikasi realtime: " + error.message;
  });
}

function renderNotifList() {
  const container = document.getElementById("notif-list");
  if (!container) return;
  const entries = Object.entries(notificationsData).sort((a,b) => b[1].created_at - a[1].created_at);
  if (!entries.length) {
    container.innerHTML = '<div style="text-align:center;padding:20px 0;color:#334155;font-size:.8125rem">Belum ada notifikasi.</div>';
    return;
  }
  const typeCfg = {
    info:    { icon:'fa-circle-info',       color:'#38bdf8', bg:'rgba(14,165,233,.1)',  bdr:'rgba(14,165,233,.2)'  },
    success: { icon:'fa-circle-check',      color:'#34d399', bg:'rgba(16,185,129,.1)',  bdr:'rgba(16,185,129,.2)'  },
    warning: { icon:'fa-triangle-exclamation', color:'#fbbf24', bg:'rgba(245,158,11,.1)', bdr:'rgba(245,158,11,.2)' },
  };
  container.innerHTML = entries.map(([id, n]) => {
    const cfg = typeCfg[n.type] || typeCfg.info;
    const date = new Date(n.created_at).toLocaleString('id-ID',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    return '<div style="background:rgba(2,6,23,.55);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:11px 12px;display:flex;gap:10px;align-items:flex-start">' +
      '<div style="width:32px;height:32px;border-radius:8px;background:'+cfg.bg+';border:1px solid '+cfg.bdr+';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
        '<i class="fa-solid '+cfg.icon+'" style="color:'+cfg.color+';font-size:13px"></i>' +
      '</div>' +
      '<div style="min-width:0;flex:1">' +
        '<div style="font-size:.875rem;font-weight:700;color:#e2e8f0;margin-bottom:2px">'+escapeHtml(n.title)+'</div>' +
        '<div style="font-size:.75rem;color:#64748b;margin-bottom:4px;line-height:1.4">'+escapeHtml(n.message)+'</div>' +
        '<div style="font-size:.625rem;color:#334155">'+date+'</div>' +
      '</div>' +
      '<button onclick="deleteNotif('+htmlJsArg(id)+')" style="background:rgba(244,63,94,.1);border:1px solid rgba(244,63,94,.2);color:#fb7185;border-radius:7px;width:28px;height:28px;padding:0;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center">' +
        '<i class="fa-solid fa-trash" style="font-size:10px"></i>' +
      '</button>' +
    '</div>';
  }).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById("notif-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const type    = document.getElementById("notif-type").value;
    const title   = document.getElementById("notif-title").value.trim();
    const message = document.getElementById("notif-message").value.trim();
    const errEl   = document.getElementById("notif-error");
    errEl.classList.add("hidden");
    if (!title || !message) { errEl.textContent = "Judul dan pesan wajib diisi."; errEl.classList.remove("hidden"); return; }
    const sb = form.querySelector("button[type=submit]");
    sb.disabled = true; sb.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:12px"></i> Mengirim...';
    try {
      const res  = await adminFetch("/api/admin/notifications", { method:"POST", body:JSON.stringify({ title, message, type }) });
      const data = await safeJson(res);
      if (!res.ok) { errEl.textContent = data.message || "Gagal."; errEl.classList.remove("hidden"); }
      else { form.reset(); }
    } catch { errEl.textContent = "Koneksi bermasalah."; errEl.classList.remove("hidden"); }
    finally { sb.disabled = false; sb.innerHTML = '<i class="fa-solid fa-bell" style="font-size:12px"></i> Broadcast ke Semua User'; }
  });
});

window.deleteNotif = async function(id) {
  const ok = await Dialog.confirmDanger("Hapus Notifikasi?", "Notifikasi akan dihapus dan tidak tampil lagi ke user.", "Ya, Hapus");
  if (!ok) return;
  try {
    const res = await adminFetch("/api/admin/notifications/"+id, { method:"DELETE" });
    if (!res.ok) { const d = await safeJson(res); await Dialog.alert("error","Gagal",d.message||"Gagal hapus."); }
  } catch { await Dialog.alert("error","Koneksi Bermasalah","Periksa koneksi internet."); }
};

// ── Users ──
let usersData = {};
let appealsData = [];
let appealsLoadInProgress = false;
let queuedAppealsRefresh = false;
const balanceAdjustmentsInProgress = new Set();
const userSearchInput = document.getElementById("user-search");

let userSearchDebounceTimer = null;
if (userSearchInput) {
  userSearchInput.addEventListener("input", () => {
    clearTimeout(userSearchDebounceTimer);
    userSearchDebounceTimer = setTimeout(() => loadUsers({
      direction: "next",
      cursor: null,
      page: 1,
    }), 250);
  });
}

function listenUsers() {
  loadUsers();
}

let usersPagination = {
  page: 1,
  has_next: false,
  has_prev: false,
  next_cursor: null,
  prev_cursor: null,
};
let usersPageRequest = { direction: "next", cursor: null, page: 1 };
let queuedUsersRequest = null;

async function loadUsers(request) {
  request = request || usersPageRequest;
  const container = document.getElementById("users-list");
  if (!container) return;
  if (usersLoadInProgress) {
    queuedUsersRequest = request;
    return;
  }
  usersLoadInProgress = true;
  container.innerHTML = '<div class="sk" style="height:52px"></div><div class="sk" style="height:52px;margin-top:7px"></div>';
  try {
    const search = userSearchInput ? userSearchInput.value.trim() : '';
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("q", search);
    if (request.cursor) {
      params.set("cursor", request.cursor);
      params.set("direction", request.direction);
    }
    const res = await adminFetch('/api/admin/users?' + params.toString());
    const data = await safeJson(res);
    if (!res.ok || !data.success) throw new Error(data.message || "Gagal memuat user.");
    usersData = {};
    data.users.forEach(user => { usersData[user.uid] = user; });
    usersPageRequest = request;
    usersPagination = {
      ...data.pagination,
      page: request.page || 1,
    };
    renderUsers();
    renderUsersPagination();
    loadAdminAppeals();
  } catch (error) {
    console.error('[loadUsers] error:', error);
    container.textContent = error.message || "Gagal memuat user.";
  } finally {
    usersLoadInProgress = false;
    if (queuedUsersRequest) {
      const nextRequest = queuedUsersRequest;
      queuedUsersRequest = null;
      loadUsers(nextRequest);
    }
  }
}

window.refreshAdminUsers = function() {
  return loadUsers();
};

window.loadUsersPrevious = function() {
  if (!usersPagination.has_prev) return;
  return loadUsers({
    direction: "previous",
    cursor: usersPagination.prev_cursor,
    page: Math.max(1, usersPagination.page - 1),
  });
};

window.loadUsersNext = function() {
  if (!usersPagination.has_next) return;
  return loadUsers({
    direction: "next",
    cursor: usersPagination.next_cursor,
    page: usersPagination.page + 1,
  });
};

async function loadAdminAppeals() {
  if (appealsLoadInProgress) {
    queuedAppealsRefresh = true;
    return;
  }
  appealsLoadInProgress = true;
  try {
    const res = await adminFetch('/api/admin/users/appeals');
    const data = await safeJson(res);
    if (!res.ok || !data.success) throw new Error(data.message || 'Gagal memuat permintaan banding.');
    appealsData = Array.isArray(data.appeals) ? data.appeals : [];
    renderAdminAppeals();
  } catch (error) {
    const list = document.getElementById('appeals-list');
    const section = document.getElementById('appeals-section');
    if (section) section.style.display = 'block';
    if (list) list.textContent = error.message || 'Gagal memuat permintaan banding.';
  } finally {
    appealsLoadInProgress = false;
    if (queuedAppealsRefresh) {
      queuedAppealsRefresh = false;
      loadAdminAppeals();
    }
  }
}

function renderAdminAppeals() {
  const section = document.getElementById('appeals-section');
  const list = document.getElementById('appeals-list');
  const count = document.getElementById('appeal-count');
  if (!section || !list) return;
  if (!appealsData.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  if (count) count.textContent = appealsData.length;
  list.innerHTML = appealsData.map(user =>
    '<div style="display:flex;align-items:center;gap:10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:10px 12px">' +
      '<i class="fa-solid fa-flag" style="color:#fbbf24;font-size:14px;flex-shrink:0"></i>' +
      '<div style="min-width:0;flex:1">' +
        '<div style="font-size:.875rem;font-weight:700;color:#e2e8f0">' + escapeHtml(user.username || user.uid) + '</div>' +
        '<div style="font-size:.6875rem;color:#334155">Alasan ban: ' + escapeHtml(user.ban_reason || '-') + '</div>' +
      '</div>' +
      '<button onclick="unbanUser(' + htmlJsArg(user.uid) + ')" style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#34d399;border-radius:8px;height:32px;padding:0 12px;font-size:.75rem;font-weight:700;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:5px">' +
        '<i class="fa-solid fa-unlock" style="font-size:10px"></i>Unbatasi' +
      '</button>' +
    '</div>'
  ).join('');
}

function renderUsersPagination() {
  const existing = document.getElementById('users-pagination-nav');
  if (existing) existing.remove();

  const p = usersPagination;
  if (!p || (!p.has_prev && !p.has_next)) return;

  const container = document.getElementById("users-list");
  if (!container || !container.parentElement) return;

  const nav = document.createElement('div');
  nav.id = 'users-pagination-nav';
  nav.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:8px';
  nav.innerHTML =
    '<button onclick="loadUsersPrevious()" ' +
      'style="height:32px;padding:0 12px;border-radius:8px;font-size:.75rem;font-weight:700;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);color:#64748b" ' +
      (p.has_prev ? '' : 'disabled') + '>← Prev</button>' +
    '<span style="font-size:.6875rem;color:#334155">Halaman ' + p.page + ' · ' + Object.keys(usersData).length + ' user</span>' +
    '<button onclick="loadUsersNext()" ' +
      'style="height:32px;padding:0 12px;border-radius:8px;font-size:.75rem;font-weight:700;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);color:#64748b" ' +
      (p.has_next ? '' : 'disabled') + '>Next →</button>';
  container.parentElement.insertBefore(nav, container.nextSibling);
}

function renderUsers() {
  const container = document.getElementById("users-list");
  if (!container) return;
  const allEntries = Object.entries(usersData).sort((a,b) => (a[1].username||'').localeCompare(b[1].username||''));
  const query = userSearchInput ? userSearchInput.value.trim().toLowerCase() : "";
  const entries = query
    ? allEntries.filter(([uid, user]) =>
        [uid, user.username, user.referral_code]
          .some(value => String(value || "").toLowerCase().includes(query))
      )
    : allEntries;

  if (!entries.length) {
    const message = query ? "Tidak ada user yang cocok dengan pencarian." : "Belum ada user.";
    container.innerHTML = '<div style="text-align:center;padding:20px 0;color:#334155;font-size:.8125rem">' + escapeHtml(message) + '</div>';
    return;
  }

  container.innerHTML = entries.map(([uid, u]) => {
    const isBanned = u.banned === true;
    return '<div style="background:rgba(2,6,23,.55);border:1px solid '+(isBanned?'rgba(244,63,94,.2)':'rgba(255,255,255,.05)')+';border-radius:10px;padding:10px 12px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="width:34px;height:34px;border-radius:9px;background:'+(isBanned?'rgba(244,63,94,.15)':'rgba(168,85,247,.1)')+';border:1px solid '+(isBanned?'rgba(244,63,94,.25)':'rgba(168,85,247,.2)')+';display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
          '<i class="fa-solid '+(isBanned?'fa-ban':'fa-user')+'" style="font-size:13px;color:'+(isBanned?'#fb7185':'#c084fc')+'"></i>' +
        '</div>' +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-size:.875rem;font-weight:700;color:'+(isBanned?'#fb7185':'#e2e8f0')+'">'+escapeHtml(u.username||uid)+'</div>' +
          '<div style="font-size:.6875rem;color:#334155;margin-top:1px">' +
            'Saldo: <span style="color:#34d399;font-weight:600">'+formatRupiah(u.balance||0)+'</span>' +
            (isBanned ? ' &nbsp;·&nbsp; <span style="color:#fb7185">Banned: '+escapeHtml(u.ban_reason||'-')+'</span>' : '') +
          '</div>' +
        '</div>' +
        '<button onclick="'+(isBanned?'unbanUser':'banUser')+'('+htmlJsArg(uid)+')" style="background:'+(isBanned?'rgba(16,185,129,.1)':'rgba(244,63,94,.1)')+';border:1px solid '+(isBanned?'rgba(16,185,129,.2)':'rgba(244,63,94,.2)')+';color:'+(isBanned?'#34d399':'#fb7185')+';border-radius:8px;height:32px;padding:0 12px;font-size:.75rem;font-weight:700;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:5px">' +
          '<i class="fa-solid '+(isBanned?'fa-unlock':'fa-ban')+'" style="font-size:10px"></i>'+(isBanned?'Unban':'Ban')+
        '</button>' +
      '</div>' +
      '<div style="display:flex;gap:7px;margin-top:9px">' +
        '<button onclick="adjustUserBalance('+htmlJsArg(uid)+',\'add\')" class="btn btn-primary btn-sm" style="flex:1"><i class="fa-solid fa-plus"></i> Tambah saldo</button>' +
        '<button onclick="adjustUserBalance('+htmlJsArg(uid)+',\'subtract\')" class="btn btn-rose btn-sm" style="flex:1"><i class="fa-solid fa-minus"></i> Kurangi saldo</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.adjustUserBalance = async function(uid, type) {
  const user = usersData[uid];
  if (!user || !['add', 'subtract'].includes(type)) return;

  const adding = type === 'add';
  const action = adding ? 'Tambah' : 'Kurangi';
  const displayName = escapeHtml(user.username || uid);
  const currentBalance = Number(user.balance) || 0;
  const body =
    '<div style="margin-bottom:10px">User: <strong style="color:#e2e8f0">' + displayName + '</strong></div>' +
    '<div style="margin-bottom:12px">Saldo saat ini: <strong style="color:#34d399">' + escapeHtml(formatRupiah(currentBalance)) + '</strong></div>' +
    '<label style="display:block;text-align:left;font-size:.75rem;color:#94a3b8;margin-bottom:5px">Nominal (Rp)</label>' +
    '<input id="balance-adjustment-amount" type="number" min="1" step="1" inputmode="numeric" placeholder="Contoh: 25000" style="width:100%;height:42px;padding:0 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:rgba(2,6,23,.8);color:#e2e8f0;font:inherit;outline:none"/>' +
    '<label style="display:block;text-align:left;font-size:.75rem;color:#94a3b8;margin:10px 0 5px">Alasan</label>' +
    '<textarea id="balance-adjustment-reason" maxlength="300" placeholder="Wajib diisi untuk catatan admin" style="width:100%;height:68px;padding:9px 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:rgba(2,6,23,.8);color:#e2e8f0;font:inherit;resize:vertical;outline:none"></textarea>';
  const confirmed = adding
    ? await Dialog.confirm(action + ' Saldo User', body)
    : await Dialog.confirmDanger(action + ' Saldo User', body, 'Ya, Kurangi Saldo');
  if (!confirmed) return;

  const amount = Number(document.getElementById('balance-adjustment-amount').value);
  const reason = document.getElementById('balance-adjustment-reason').value.trim();
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await Dialog.alert('error', 'Nominal Tidak Valid', 'Masukkan nominal bilangan bulat yang lebih dari nol.');
    return;
  }
  if (!reason || reason.length > 300) {
    await Dialog.alert('error', 'Alasan Wajib Diisi', 'Isi alasan penyesuaian saldo, maksimal 300 karakter.');
    return;
  }
  if (!adding && amount > currentBalance) {
    await Dialog.alert('error', 'Saldo Tidak Cukup', 'Nominal pengurangan melebihi saldo user.');
    return;
  }
  if (balanceAdjustmentsInProgress.has(uid)) return;

  balanceAdjustmentsInProgress.add(uid);
  try {
    const res = await adminFetch('/api/admin/users/' + encodeURIComponent(uid) + '/balance-adjustments', {
      method: 'POST',
      body: JSON.stringify({ type, amount, reason }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      await Dialog.alert('error', 'Gagal Mengubah Saldo', data.message || 'Saldo user tidak berhasil diperbarui.');
      return;
    }

    await loadUsers();
    await Dialog.alert('success', 'Saldo Diperbarui', data.message + ' Saldo sekarang: ' + formatRupiah(data.balance) + '.');
  } catch {
    await Dialog.alert('error', 'Koneksi Bermasalah', 'Tidak dapat memperbarui saldo user. Muat ulang daftar user sebelum mencoba lagi.');
  } finally {
    balanceAdjustmentsInProgress.delete(uid);
  }
};

window.banUser = async function(uid) {
  const user = usersData[uid];
  if (!user) return;
  const ok = await Dialog.confirmDanger(
    "Ban User?",
    '<div style="margin-bottom:10px">User: <strong style="color:#e2e8f0">'+escapeHtml(user.username||uid)+'</strong></div>' +
    '<textarea id="ban-reason-input" placeholder="Alasan ban..." style="width:100%;background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#e2e8f0;font-family:inherit;font-size:.8125rem;padding:10px;resize:none;outline:none;height:72px;box-sizing:border-box;margin-top:4px"></textarea>',
    "Ya, Ban"
  );
  if (!ok) return;
  const reason = document.getElementById('ban-reason-input')?.value?.trim() || 'Pelanggaran kebijakan';
  try {
    const res = await adminFetch('/api/admin/users/'+encodeURIComponent(uid)+'/ban', { method:'POST', body:JSON.stringify({ reason }) });
    const data = await safeJson(res);
    if (!res.ok) await Dialog.alert('error','Gagal', data.message||'Gagal ban user.');
    else loadUsers();
  } catch { await Dialog.alert('error','Koneksi Bermasalah','Periksa koneksi internet.'); }
};

window.unbanUser = async function(uid) {
  const user = usersData[uid] || appealsData.find(appeal => appeal.uid === uid);
  if (!user) return;
  const ok = await Dialog.confirm('Unban User?', 'User <strong style="color:#e2e8f0">'+escapeHtml(user.username||uid)+'</strong> akan di-unban dan bisa login kembali.');
  if (!ok) return;
  try {
    const res = await adminFetch('/api/admin/users/'+encodeURIComponent(uid)+'/unban', { method:'POST' });
    const data = await safeJson(res);
    if (!res.ok) await Dialog.alert('error','Gagal', data.message||'Gagal unban user.');
    else loadUsers();
  } catch { await Dialog.alert('error','Koneksi Bermasalah','Periksa koneksi internet.'); }
};
