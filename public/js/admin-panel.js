// ADMIN PANEL
let adminUser = null, adminToken = null, currentStockTab = "indo";
let stockData = {}, countriesData = {}, ordersData = {};

// ── Auth ──
firebaseAuth.onAuthStateChanged(async (user) => {
  if (user) { adminUser = user; adminToken = await user.getIdToken(); await verifyAdmin(); }
  else { adminUser = null; adminToken = null; showLoginScreen(); }
});

async function verifyAdmin() {
  try {
    const res = await adminFetch("/api/admin/verify");
    if (res.ok) showApp();
    else { hide("login-screen"); show("access-denied","flex"); }
  } catch { hide("login-screen"); show("access-denied","flex"); }
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

async function adminFetch(url, opts = {}) {
  if (adminUser) adminToken = await adminUser.getIdToken(false);
  return fetch(url, { ...opts, headers: { "Content-Type":"application/json", "Authorization":"Bearer "+adminToken, ...(opts.headers||{}) } });
}

async function safeJson(res) {
  const t = await res.text();
  if (!t || !t.trim()) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

function hide(id) { const el=document.getElementById(id); if(el) el.style.display="none"; }
function show(id,d="block") { const el=document.getElementById(id); if(el) el.style.display=d; }

function showLoginScreen() { show("login-screen","flex"); hide("app-screen"); }

function showApp() {
  hide("login-screen"); hide("access-denied"); show("app-screen","flex");
  document.getElementById("admin-username").textContent = adminUser.email;
  initAdmin();
}

function initAdmin() { listenOrders(); listenStock(); listenCountries(); }

// ── Nav tabs ──
window.showAdminTab = function(tab) {
  ["orders","stock","countries"].forEach(t => {
    const el = document.getElementById("tab-"+t);
    if (el) el.style.display = "none";
    const nav = document.getElementById("nav-"+t);
    if (nav) { nav.classList.remove("active"); }
  });
  const tabEl = document.getElementById("tab-"+tab);
  if (tabEl) tabEl.style.display = "block";
  const navEl = document.getElementById("nav-"+tab);
  if (navEl) navEl.classList.add("active");
};

// ── Orders ──
function listenOrders() {
  firebaseDB.ref("orders").on("value", (snap) => {
    ordersData = {};
    if (snap.exists()) snap.forEach(c => {
      const o = c.val();
      if (o.status === "WAITING_OTP" || o.status === "OTP_REQUESTED") ordersData[c.key] = o;
    });
    renderOrders();
  });
}

function renderOrders() {
  const container = document.getElementById("order-list");
  const entries   = Object.entries(ordersData).slice(0, 200);
  document.getElementById("order-count").textContent = entries.length;

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
    const isOtp = o.status === "OTP_REQUESTED";
    const tClr  = rem <= 60 ? "#fb7185" : rem <= 120 ? "#fbbf24" : "#34d399";

    const badge = isOtp
      ? '<span style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);color:#fbbf24;font-size:.6875rem;font-weight:600;padding:2px 8px;border-radius:20px"><i class="fa-solid fa-paper-plane" style="font-size:10px;margin-right:3px"></i>OTP Diminta</span>'
      : '<span style="background:rgba(14,165,233,.1);border:1px solid rgba(14,165,233,.2);color:#38bdf8;font-size:.6875rem;font-weight:600;padding:2px 8px;border-radius:20px"><i class="fa-regular fa-clock" style="font-size:10px;margin-right:3px"></i>Menunggu</span>';

    const otpBlock = isOtp ? (
      '<div style="background:rgba(2,6,23,.55);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:12px;margin-top:10px;display:flex;flex-direction:column;gap:8px">' +
        '<div id="otp-err-'+id+'" style="display:none;color:#fda4af;font-size:.75rem;align-items:center;gap:5px">' +
          '<i class="fa-solid fa-circle-exclamation" style="font-size:11px"></i><span></span>' +
        '</div>' +
        '<div style="display:flex;gap:7px">' +
          '<input type="text" id="otp-inp-'+id+'" placeholder="Kode OTP (4-8 digit)" maxlength="8"' +
            ' style="flex:1;background:rgba(2,6,23,.8);border:1px solid rgba(255,255,255,.09);border-radius:9px;color:#e2e8f0;font-family:\'JetBrains Mono\',monospace;font-size:.875rem;height:38px;padding:0 10px;outline:none;letter-spacing:.1em"/>' +
          '<button onclick="submitOtp(\''+id+'\')"' +
            ' style="background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.25);color:#c084fc;border-radius:9px;height:38px;padding:0 14px;font-size:.8125rem;font-weight:700;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px">' +
            '<i class="fa-solid fa-paper-plane" style="font-size:11px"></i>Kirim' +
          '</button>' +
        '</div>' +
        (o.otp_code ? '<div style="font-size:.75rem;color:#34d399;display:flex;align-items:center;gap:5px"><i class="fa-solid fa-circle-check" style="font-size:11px"></i>OTP terkirim: <strong style="font-family:\'JetBrains Mono\',monospace;letter-spacing:.1em">'+o.otp_code+'</strong></div>' : '') +
        '<button onclick="completeOrder(\''+id+'\')"' +
          ' style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#34d399;border-radius:9px;height:38px;font-size:.8125rem;font-weight:700;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:6px">' +
          '<i class="fa-solid fa-circle-check" style="font-size:12px"></i> Done / Selesai' +
        '</button>' +
      '</div>'
    ) : '<div style="font-size:.75rem;color:#334155;margin-top:8px;font-style:italic">Menunggu user klik minta OTP...</div>';

    return '<div class="card fu" style="padding:12px 14px" id="card-'+id+'">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
        '<div style="min-width:0;flex:1">' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.625rem;color:#1e293b;margin-bottom:3px">'+id+'</div>' +
          '<div style="font-size:.875rem;font-weight:700;color:#e2e8f0;margin-bottom:1px">'+(o.username||o.user_id)+'</div>' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.875rem;color:#cbd5e1;margin-bottom:2px">'+o.phone_number+'</div>' +
          '<div style="font-size:.6875rem;color:#475569"><i class="fa-solid fa-location-dot" style="font-size:10px;margin-right:3px"></i>'+(o.country_name||o.country_key)+'</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:5px">' +
          badge +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:.875rem;color:'+tClr+';display:flex;align-items:center;gap:4px">' +
            '<i class="fa-regular fa-clock" style="font-size:10px"></i>'+m+':'+s+
          '</div>' +
          '<div style="font-size:.6875rem;color:#334155"><i class="fa-solid fa-rotate-right" style="font-size:10px;margin-right:2px"></i>Resend: '+(o.resend_count||0)+'x</div>' +
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

// ── Stock ──
function listenStock() {
  firebaseDB.ref("phone_stocks").on("value", (snap) => {
    stockData = snap.val() || {};
    renderStockList(); updateStockCounts(); updateStockFilterCountry();
  });
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
    keys.map(k => { const c=countriesData[k]; return '<option value="'+k+'"'+(cur===k?" selected":"")+'>'+(c?(c.flag||"")+" "+c.country_name:k)+'</option>'; }).join("");
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
    const canDelete = s.status !== "LOCKED"; // tidak bisa hapus yang terkunci
    const deleteBtn = canDelete
      ? '<button onclick="deleteStock(\''+stockId+'\')" style="background:rgba(244,63,94,.1);border:1px solid rgba(244,63,94,.2);color:#fb7185;border-radius:7px;width:28px;height:28px;padding:0;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center" title="Hapus"><i class="fa-solid fa-trash" style="font-size:10px"></i></button>'
      : '<button disabled style="background:rgba(100,116,139,.05);border:1px solid rgba(100,116,139,.1);color:#334155;border-radius:7px;width:28px;height:28px;padding:0;cursor:not-allowed;flex-shrink:0;display:flex;align-items:center;justify-content:center;opacity:.3" title="Tidak bisa hapus (terkunci)"><i class="fa-solid fa-lock" style="font-size:9px"></i></button>';
    return '<div style="display:flex;align-items:center;gap:8px;background:rgba(2,6,23,.55);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:7px 10px">' +
      '<span style="font-size:1rem;line-height:1;flex-shrink:0">'+(c?c.flag||"":"")+'</span>' +
      '<span style="font-family:\'JetBrains Mono\',monospace;font-size:.75rem;color:#94a3b8;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+s.number+'</span>' +
      '<span class="'+(sClr[s.status]||"s-exp")+'" style="font-size:.625rem;font-weight:600;padding:2px 7px;border-radius:20px;flex-shrink:0">'+s.status+'</span>' +
      deleteBtn +
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
    filtered.map(([k,c]) => '<option value="'+k+'">'+(c.flag||"")+" "+c.country_name+" — "+formatRupiah(c.price)+'</option>').join("");
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
  });
}

function renderCountriesList() {
  const c = document.getElementById("countries-list");
  const entries = Object.entries(countriesData);
  if (!entries.length) {
    c.innerHTML = '<div style="text-align:center;padding:28px 0;color:#334155;font-size:.8125rem">Belum ada negara.</div>';
    return;
  }
  c.innerHTML = entries.map(([k,v]) => {
    const avail = Object.values(stockData).filter(s=>s.country_key===k&&s.status==="AVAILABLE").length;
    const tb = v.tab==="indo"
      ? '<span style="background:rgba(16,185,129,.1);color:#34d399;border:1px solid rgba(16,185,129,.18);font-size:.625rem;font-weight:600;padding:1px 6px;border-radius:20px">Indo</span>'
      : '<span style="background:rgba(14,165,233,.1);color:#38bdf8;border:1px solid rgba(14,165,233,.18);font-size:.625rem;font-weight:600;padding:1px 6px;border-radius:20px">Luar</span>';
    return '<div style="display:flex;align-items:center;justify-content:space-between;background:rgba(2,6,23,.55);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:10px 12px;gap:10px">' +
      '<div style="display:flex;align-items:center;gap:10px;min-width:0">' +
        '<span style="font-size:1.375rem;line-height:1;flex-shrink:0">'+(v.flag||"")+'</span>' +
        '<div style="min-width:0">' +
          '<div style="display:flex;align-items:center;gap:5px;margin-bottom:2px">' +
            '<span style="font-size:.875rem;font-weight:700;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+v.country_name+'</span>'+tb+
          '</div>' +
          '<span style="font-family:\'JetBrains Mono\',monospace;font-size:.625rem;color:#334155">'+k+'</span>' +
        '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:700;font-size:.875rem;color:#34d399">'+formatRupiah(v.price)+'</div>' +
        '<div style="font-size:.6875rem;color:#334155;margin-top:1px"><i class="fa-solid fa-layer-group" style="font-size:10px;margin-right:2px"></i>'+avail+' tersedia</div>' +
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

// ── Delete Stock ──
window.deleteStock = async function(stockId) {
  const stock = stockData[stockId];
  if (!stock) return;
  const ok = await Dialog.confirmDanger(
    "Hapus Stok?",
    "Nomor <strong style='color:#e2e8f0;font-family:\"JetBrains Mono\",monospace'>"+stock.number+"</strong> akan dihapus permanen.",
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
