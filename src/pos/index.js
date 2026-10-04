import { supabase } from "../core/supabase.js";
import { DEFAULT_SETTINGS, versionedAsset } from "../core/config.js";
import { createPOSState } from "../core/posState.js";
import { escapeHtml, money, mountNavigation, openAppModal, showToast } from "../components/navigation.js";

// --- INSTANT URL SCRUBBER (LIGHTNING FAST) ---
// This executes the exact millisecond the browser reads this file, before any UI loads.
const _initParams = new URLSearchParams(window.location.search);
const _initTable = _initParams.get("table") || _initParams.get("t");
const _initScan = _initParams.get("scan");

if (_initTable && _initScan && _initScan.toLowerCase() === "true") {
    // 1. Instantly wipe the old session memory
    localStorage.removeItem(`fourflavours.session.${_initTable}`);
    
    // 2. Instantly erase 'scan=true' from the address bar while keeping the #hash
    const _cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + "?table=" + _initTable + window.location.hash;
    window.history.replaceState({ path: _cleanUrl }, '', _cleanUrl);
}
// ---------------------------------------------

export async function render({ mount }) {
  if (!supabase) {
    mount.innerHTML = `<section class="access-screen dark-access"><div class="access-card"><img class="access-logo" src="${versionedAsset("assets/images/website_icon.svg")}" alt=""><h1>Four Flavours POS</h1><p>Supabase configuration is missing.</p></div></section>`;
    return () => {};
  }

  const [settingsResult, productsResult, tablesResult, cuisinesResult] = await Promise.all([
    supabase.from("app_settings").select("*").eq("id", 1).maybeSingle(),
    supabase.from("products").select("*").eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }),
    supabase.from("tables").select("id, table_no, capacity, is_active").eq("is_active", true).order("table_no", { ascending: true }),
    supabase.from("cuisines").select("*").order("sort_order", { ascending: true })
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (productsResult.error) throw productsResult.error;
  if (tablesResult.error) throw tablesResult.error;

  const settings = { ...DEFAULT_SETTINGS, ...(settingsResult.data ?? {}) };
  const products = productsResult.data ?? [];
  const cuisines = cuisinesResult.data ?? [];
  
  // NATURAL SORT: Forces "10" to come after "9" instead of after "1"
  const tables = (tablesResult.data ?? []).sort((a, b) => 
    String(a.table_no).localeCompare(String(b.table_no), undefined, { numeric: true, sensitivity: 'base' })
  );
  
  // Synchronous dictionary for the global notification engine
  window.__FF_TABLES__ = tables;
  
  // --- SHAPE-SHIFTING VIEWPORT DETECTION ---
  const urlParams = new URLSearchParams(window.location.search);
  const qrTableId = urlParams.get("table") || urlParams.get("t");
  const isCustomerMode = Boolean(qrTableId);
  
  // SECURE SCAN INTENT: Detect if this is a fresh physical QR scan (Case-Insensitive)
  const scanParam = urlParams.get("scan");
  const isPhysicalScan = scanParam && scanParam.toLowerCase() === "true";
  
  let customerSessionToken = null;
  const currentTableObj = isCustomerMode ? tables.find(t => t.id === qrTableId) : null;

  if (isCustomerMode) {
    if (!currentTableObj) {
      mount.innerHTML = `<main class="customer-page"><section class="customer-message"><div class="message-mark"><i class="ph ph-qr-code"></i></div><span class="eyebrow">Four Flavours</span><h1>Table unavailable</h1><p>This QR code is invalid or no longer active.</p></section></main>`;
      return () => {};
    }
    
    const sessionKey = `fourflavours.session.${currentTableObj.id}`;
    
    // If the user physically scanned the sticker, clear their memory and scrub the URL
    if (isPhysicalScan) {
        localStorage.removeItem(sessionKey);
        // Instantly wipe '&scan=true' from the address bar so they cannot bookmark or copy it!
        const hash = window.location.hash;
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + "?table=" + qrTableId + hash;
        window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
    }

    const existingToken = localStorage.getItem(sessionKey);

    // 1. REMOTE GHOST-ORDER PREVENTION: Check if the user's saved session is closed
    if (existingToken) {
        const { data: mySession } = await supabase.from("dining_sessions")
            .select("status, updated_at")
            .eq("session_token", existingToken)
            .maybeSingle();

        if (mySession && mySession.status === "closed") {
            const closedDate = new Date(mySession.updated_at);
            const hoursSinceClosed = (Date.now() - closedDate.getTime()) / (1000 * 60 * 60);

            // Lock them out for 12 hours so they cannot order from home later in the day
            if (hoursSinceClosed < 12) {
                const timeString = closedDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                const dateString = closedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                
                mount.innerHTML = `
                  <style>
                    @keyframes lockSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                    @keyframes lockPulse { 0% { box-shadow: 0 0 0 0 rgba(18, 34, 22, 0.1); transform: scale(1); } 50% { box-shadow: 0 0 0 15px rgba(18, 34, 22, 0); transform: scale(1.05); } 100% { box-shadow: 0 0 0 0 rgba(18, 34, 22, 0); transform: scale(1); } }
                    .premium-lock-screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--paper, #FCFCF9); padding: 24px; font-family: inherit; }
                    .premium-lock-card { background: #ffffff; max-width: 440px; width: 100%; border-radius: 24px; padding: 40px 32px; box-shadow: 0 12px 40px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.02); text-align: center; animation: lockSlideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
                    .premium-lock-icon { width: 100px; height: 100px; background: transparent; border: none; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; animation: lockPulse 3s infinite ease-in-out; }
                    .premium-lock-icon img { width: 100%; height: 100%; object-fit: contain; }
                    .premium-lock-title { font-size: 1.75rem; font-weight: 900; color: var(--forest-950); letter-spacing: -0.02em; margin: 0 0 12px 0; }
                    .premium-lock-desc { color: var(--forest-700); font-size: 0.95rem; line-height: 1.5; margin: 0 0 32px 0; }
                    .premium-lock-notice { background: #f8faf9; border-radius: 16px; border: 1px solid rgba(18,34,22,0.08); padding: 20px; display: flex; gap: 14px; text-align: left; align-items: flex-start; }
                    .premium-lock-notice i { color: var(--forest-900); font-size: 22px; margin-top: 2px; }
                    .premium-lock-notice strong { display: block; color: var(--forest-950); font-size: 0.9rem; margin-bottom: 4px; }
                    .premium-lock-notice span { color: var(--forest-700); font-size: 0.85rem; line-height: 1.5; }
                  </style>
                  <main class="premium-lock-screen">
                    <div class="premium-lock-card">
                      <div class="premium-lock-icon">
                        <img src="${versionedAsset("assets/images/ses_exp.svg")}" alt="Session Expired">
                      </div>
                      <h1 class="premium-lock-title">Session Expired</h1>
                      <p class="premium-lock-desc">Your dining session for <strong>Table ${currentTableObj.table_no}</strong> was completed on <br><strong style="color: var(--forest-950);">${dateString} at ${timeString}</strong>.</p>
                      <div class="premium-lock-notice">
                          <i class="ph-bold ph-shield-check"></i>
                          <div>
                            <strong>Security Lock Active</strong>
                            <span>To prevent remote ordering, this QR link is temporarily locked. If you are still at the restaurant, please ask a staff member to clear the table.</span>
                          </div>
                      </div>
                    </div>
                  </main>
                `;
                return () => {};
            } else {
                localStorage.removeItem(sessionKey);
            }
        }
    }

    // 2. OCCUPIED TABLE PREVENTION: Ensure the table isn't actively held by another customer
    const { data: activeTableSession } = await supabase.from("dining_sessions")
        .select("session_token")
        .eq("table_id", currentTableObj.id)
        .neq("status", "closed")
        .maybeSingle();
    
    if (activeTableSession && activeTableSession.session_token !== localStorage.getItem(sessionKey)) {
        mount.innerHTML = `
          <style>
            @keyframes lockSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes pulseDanger { 0% { box-shadow: 0 0 0 0 rgba(225, 29, 72, 0.4); } 70% { box-shadow: 0 0 0 20px rgba(225, 29, 72, 0); } 100% { box-shadow: 0 0 0 0 rgba(225, 29, 72, 0); } }
            @keyframes shakeIcon { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-4px) rotate(-4deg); } 40% { transform: translateX(4px) rotate(4deg); } 60% { transform: translateX(-4px) rotate(-4deg); } 80% { transform: translateX(4px) rotate(4deg); } }
            .premium-lock-screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: var(--paper, #FCFCF9); padding: 24px; font-family: inherit; }
            .premium-lock-card { background: #ffffff; max-width: 440px; width: 100%; border-radius: 28px; padding: 48px 32px; box-shadow: 0 24px 48px rgba(18,34,22,0.06), 0 0 0 1px rgba(18,34,22,0.02); text-align: center; animation: lockSlideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
            
            /* Colorful Animated Gradient Icon */
            .premium-lock-icon-danger { 
                width: 96px; 
                height: 96px; 
                background: linear-gradient(135deg, #ff4b4b 0%, #e11d48 100%); 
                border-radius: 28px; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                margin: 0 auto 24px; 
                color: #ffffff; 
                animation: pulseDanger 2.5s infinite, shakeIcon 0.6s ease-in-out 0.2s; 
                box-shadow: 0 12px 24px rgba(225, 29, 72, 0.25); 
            }
            
            .premium-lock-title { font-size: 1.85rem; font-weight: 900; color: var(--forest-950); letter-spacing: -0.02em; margin: 0 0 12px 0; }
            .premium-lock-desc { color: var(--forest-700); font-size: 1rem; line-height: 1.5; margin: 0 0 32px 0; }
            .try-again-btn { width: 100%; border-radius: 12px; height: 52px; display: flex; align-items: center; justify-content: center; gap: 8px; background: #ffffff; border: 1px solid var(--line); color: var(--forest-900); font-size: 1rem; font-weight: 800; cursor: pointer; transition: background 0.2s, transform 0.1s; }
            .try-again-btn:active { transform: scale(0.98); }
          </style>
          <main class="premium-lock-screen">
            <div class="premium-lock-card">
              <div class="premium-lock-icon-danger">
                <!-- Using a universally supported Phosphor icon with drop shadow -->
                <i class="ph-fill ph-hand-palm" style="font-size: 48px; filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.2));"></i>
              </div>
              <h1 class="premium-lock-title">Table Occupied</h1>
              <p class="premium-lock-desc">Table ${currentTableObj.table_no} is currently in use by another guest's device.</p>
              
              <button class="try-again-btn" onclick="window.location.reload()"><i class="ph-bold ph-arrows-clockwise" style="font-size: 20px;"></i> Try Again</button>
            </div>
          </main>
        `;
        return () => {};
    }

    // 3. Bootstrap secure customer session
    const { data: sessionBootstrap, error: sessionError } = await supabase.rpc("ensure_customer_session", { p_table_id: currentTableObj.id });
    if (sessionError) throw sessionError;
    
    customerSessionToken = (sessionBootstrap?.[0] ?? sessionBootstrap)?.session_token;
    if (customerSessionToken) localStorage.setItem(sessionKey, customerSessionToken);
  }

  const state = createPOSState({ settings });
  
  // Securely configure explicit broadcast channel
  const adminAlertChannel = supabase.channel('ff-admin-alerts');
  adminAlertChannel.subscribe();
  
  // Lock the state machine immediately for customers
  if (isCustomerMode) {
    state.setOrderType("dine_in");
    state.setTable(currentTableObj);
  }

  let activeCuisine = null;
  let activeSubCategory = "All";
  let searchTerm = "";
  let drawerCleanup = null;
  let realtimeChannel = null;
  let unreadOrders = 0;
  
  const activeTableOrders = {}; // Tracks open bills per table globally!

  // Intercept the physical mobile back button
  const handlePopState = (e) => {
    if (e.state?.view === "cuisine" && e.state?.cuisine) {
      activeCuisine = e.state.cuisine;
      activeSubCategory = "All";
    } else {
      activeCuisine = null;
      activeSubCategory = "All";
    }
    searchTerm = "";
    const searchField = document.querySelector("#pos-search");
    if (searchField) searchField.value = "";
    renderProducts();
  };
  window.addEventListener("popstate", handlePopState);

  mount.innerHTML = `
    <section class="pos-page ${isCustomerMode ? 'customer-viewport' : 'staff-viewport'}">
      <header class="app-topbar pos-topbar">
        <div class="topbar-side topbar-left" style="gap: 14px; align-items: center; display: flex;">
          ${isCustomerMode ? `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: auto; height: 42px; padding: 4px 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; flex-shrink: 0;">
              <i class="ph-bold ph-armchair" style="color: var(--gold-400); font-size: 18px; line-height: 1; margin-bottom: 4px;"></i>
              <span style="color: #fff; font-size: 10px; font-weight: 800; letter-spacing: 0.06em; line-height: 1; text-transform: uppercase; white-space: nowrap;">Table ${escapeHtml(currentTableObj?.table_no ?? "—")}</span>
            </div>
          ` : `
            <button class="icon-btn icon-btn-dark" id="pos-menu" title="Open menu" aria-label="Open menu" style="position: relative;">
              <i class="ph ph-list"></i>
              <span class="hamburger-dot" style="position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; border-radius: 50%; background: #e11d48; display: none; border: 2px solid var(--paper);"></span>
            </button>
          `}
          <img src="${versionedAsset("assets/images/website_logo.svg")}" alt="Four Flavours" style="height: 46px; width: auto; max-height: none; object-fit: contain; flex-shrink: 0;" />
        </div>
        <div class="brand-center pos-brand-center main-logo-only"></div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="pos-search-toggle" title="Search"><i class="ph ph-magnifying-glass"></i></button>
          ${isCustomerMode ? `
            <button class="icon-btn icon-btn-dark" id="customer-live-tab" title="View Live Tab"><i class="ph-bold ph-receipt"></i></button>
          ` : ``}
        </div>
      </header>
      
      <div class="pos-search-backdrop" id="pos-search-overlay" style="z-index: 99999;" onclick="this.classList.remove('active');">
        <div class="pos-search-panel" onclick="event.stopPropagation();">
          <div class="search-bar-row">
            <div class="search-input-wrap">
              <i class="ph-bold ph-magnifying-glass"></i>
              <input id="pos-search" class="search-input" type="search" placeholder="Search dishes or categories..." autocomplete="off" oninput="document.getElementById('search-suggestions-area').style.display = this.value.trim() ? 'none' : 'block';" onkeydown="if(event.key === 'Enter') document.getElementById('pos-search-overlay').classList.remove('active');">
            </div>
            <button class="btn btn-quiet" id="pos-search-cancel" onclick="document.getElementById('pos-search-overlay').classList.remove('active'); const i = document.getElementById('pos-search'); i.value = ''; i.dispatchEvent(new Event('input')); document.getElementById('search-suggestions-area').style.display = 'block';" style="padding: 0 12px; border: none; background: transparent; color: var(--forest-900); font-weight: 800;">Cancel</button>
          </div>
          
          <div id="search-suggestions-area">
            <div class="search-group-title">Recommended</div>
            <div class="search-tags">
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Paneer'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-trend-up"></i> Paneer</button>
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Soup'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-fire"></i> Soups</button>
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Noodles'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-star"></i> Noodles</button>
              <button class="search-tag" onclick="const i = document.getElementById('pos-search'); i.value = 'Rice'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');"><i class="ph ph-bowl-food"></i> Rice</button>
            </div>
            
            <div class="search-group-title">Recently Ordered</div>
            <div class="search-list">
              <button class="search-list-item" onclick="const i = document.getElementById('pos-search'); i.value = 'Manchow'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');">
                <i class="ph-bold ph-clock-counter-clockwise"></i>
                <span>Veg Manchow Soup</span>
                <small>₹169</small>
              </button>
              <button class="search-list-item" onclick="const i = document.getElementById('pos-search'); i.value = 'Tikka'; i.dispatchEvent(new Event('input')); document.getElementById('pos-search-overlay').classList.remove('active');">
                <i class="ph-bold ph-clock-counter-clockwise"></i>
                <span>Paneer Tikka</span>
                <small>₹289</small>
              </button>
            </div>
          </div>
        </div>
      </div>

      <main class="pos-content">
        <div id="pos-dynamic-area"></div>
      </main>

      <footer class="pos-action-bar">
        <div class="pos-action-summary">
          <div class="action-summary-icon"><i class="ph ph-receipt"></i></div>
          <div><strong id="pos-cart-count">0 items</strong><span id="pos-cart-total">Tap Next to review</span></div>
        </div>
        <button class="btn btn-primary pos-next-btn" id="pos-next"><span>Next</span><i class="ph ph-arrow-right"></i></button>
      </footer>
      <div id="pos-overlay-root"></div>
    </section>`;

  drawerCleanup = mountNavigation({ active: "pos" });
  if (!isCustomerMode) {
    mount.querySelector("#pos-menu").addEventListener("click", () => window.__FOUR_FLAVOURS_NAV__?.open());
  }
  
  const searchInput = mount.querySelector("#pos-search");
  const searchOverlay = mount.querySelector("#pos-search-overlay");
  
  mount.querySelector("#pos-search-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    searchOverlay.classList.toggle("active");
    if (searchOverlay.classList.contains("active")) searchInput.focus();
  });

  const handleOutsideClick = (e) => {
    if (searchOverlay && !searchOverlay.contains(e.target) && !e.target.closest("#pos-search-toggle")) {
      searchOverlay.classList.remove("active");
    }
  };
  document.addEventListener("click", handleOutsideClick);

  searchInput.addEventListener("input", event => { searchTerm = event.target.value.trim().toLowerCase(); renderProducts(); });
  
  if (isCustomerMode) {
    mount.querySelector("#customer-live-tab").addEventListener("click", openLiveTabDashboard);
  } else {
    state.setOrderType("dine_in");
  }
  
  mount.querySelector("#pos-next").addEventListener("click", openReview);

  async function openLiveTabDashboard() {
    const tableId = isCustomerMode ? currentTableObj.id : state.getState().tableId;
    if (!tableId) return;

    const btn = mount.querySelector("#customer-live-tab");
    if (btn) { btn.classList.remove("qty-pulse"); void btn.offsetWidth; btn.classList.add("qty-pulse"); }

    const { data: session } = await supabase.from("dining_sessions")
      .select("id, status")
      .eq("table_id", tableId)
      .in("status", ["open", "bill_requested", "bill_ready"])
      .maybeSingle();

    if (!session) {
       return openAppModal({
          title: "Your Tab is Empty",
          subtitle: "You haven't sent any items to the kitchen yet.",
          body: `<div class="empty-state"><i class="ph-bold ph-receipt"></i><strong>Nothing here yet</strong><span>Add dishes to your cart and tap "Next" to start your order.</span></div>`,
          actions: [{ label: "Browse Menu", icon: "ph-arrow-left", className: "btn-primary", onClick: ({ close }) => close() }]
       });
    }

    const { data: order } = await supabase.from("orders").select("*").eq("session_id", session.id).limit(1).maybeSingle();
    
    if (!order) {
       return openAppModal({
          title: "Your Tab is Empty",
          subtitle: "You haven't sent any items to the kitchen yet.",
          body: `<div class="empty-state"><i class="ph-bold ph-receipt"></i><strong>Nothing here yet</strong><span>Add dishes to your cart and tap "Next" to start your order.</span></div>`,
          actions: [{ label: "Browse Menu", icon: "ph-arrow-left", className: "btn-primary", onClick: ({ close }) => close() }]
       });
    }

    showActiveOrderDashboard({ order, settings, current_state: { tableId, orderType: "dine_in" }, sessionKey: tableId });
  }

  let unseenBillRequests = 0;

  realtimeChannel = supabase.channel(`live-orders-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, payload => {
        if (payload.new?.note === "Customer Self-Order") {
           if (window.triggerAdminNotification) window.triggerAdminNotification();
        }
        window.dispatchEvent(new Event("ff_live_update"));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, payload => {
        // SUPER LIVE SYNC: Instantly update the customer's Live Tab when Admin adds items!
        window.dispatchEvent(new Event("ff_live_update"));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dining_sessions" }, payload => {
        if (isCustomerMode && payload.new?.status === "closed" && payload.new?.table_id === currentTableObj.id) {
           
           document.querySelectorAll('.app-modal').forEach(m => m.remove());
           document.body.classList.remove('modal-open');
           
           document.getElementById("app").innerHTML = `
              <style>
                @keyframes tyAmbientGlow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
                @keyframes tyCardEnter { 0% { opacity: 0; transform: translateY(40px) scale(0.98); box-shadow: 0 0 0 rgba(0,0,0,0); } 100% { opacity: 1; transform: translateY(0) scale(1); box-shadow: 0 24px 48px rgba(18, 34, 22, 0.08), 0 0 0 1px rgba(18, 34, 22, 0.03); } }
                @keyframes tyLogoReveal { 0% { opacity: 0; transform: scale(0.5) rotate(-15deg); } 50% { opacity: 1; transform: scale(1.1) rotate(5deg); } 100% { opacity: 1; transform: scale(1) rotate(0deg); } }
                @keyframes tyFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
                @keyframes tyTextFade { 0% { opacity: 0; transform: translateY(15px); } 100% { opacity: 1; transform: translateY(0); } }
                @keyframes tyLineDraw { 0% { width: 0; opacity: 0; } 100% { width: 48px; opacity: 1; } }

                .ty-wrapper { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 24px; background: linear-gradient(120deg, #fdfbf7, #f4f7f5, #fdf8ed); background-size: 200% 200%; animation: tyAmbientGlow 8s ease infinite; }
                .ty-card { background: #ffffff; border-radius: 32px; padding: 64px 40px; text-align: center; max-width: 480px; width: 100%; position: relative; overflow: hidden; opacity: 0; animation: tyCardEnter 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
                .ty-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, var(--gold-400), var(--gold-500), var(--gold-400)); }
                .ty-logo-wrap { width: 110px; height: 110px; margin: 0 auto 32px; display: flex; align-items: center; justify-content: center; background: #f8faf9; border-radius: 50%; border: 1px solid rgba(18, 34, 22, 0.04); opacity: 0; animation: tyLogoReveal 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s forwards, tyFloat 4s ease-in-out 1s infinite; }
                .ty-logo-wrap img { width: 64px; height: auto; object-fit: contain; }
                .ty-title { font-size: 2.5rem; font-weight: 900; color: var(--forest-950); letter-spacing: -0.02em; margin: 0 0 16px; opacity: 0; animation: tyTextFade 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.3s forwards; }
                .ty-subtitle { font-size: 1.15rem; color: var(--forest-800); line-height: 1.5; font-weight: 500; margin: 0 0 32px; opacity: 0; animation: tyTextFade 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.4s forwards; }
                .ty-divider { height: 3px; background: var(--gold-500); margin: 0 auto 32px; border-radius: 2px; opacity: 0; animation: tyLineDraw 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.5s forwards; }
                .ty-footer { font-size: 1rem; color: var(--forest-600); line-height: 1.6; margin: 0; opacity: 0; animation: tyTextFade 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.6s forwards; }
              </style>
              <div class="ty-wrapper">
                 <div class="ty-card">
                    <div class="ty-logo-wrap">
                      <img src="${versionedAsset("assets/images/website_icon.svg")}" alt="Four Flavours Logo">
                    </div>
                    <h1 class="ty-title">Thank You!</h1>
                    <p class="ty-subtitle">Your bill is on the way to your table.</p>
                    <div class="ty-divider"></div>
                    <p class="ty-footer">We hope you enjoyed your time at Four Flavours.<br>Please wait while our staff attends to you.</p>
                 </div>
              </div>
           `;
        }
        window.dispatchEvent(new Event("ff_live_update"));
      })
      .subscribe(status => { const node = mount.querySelector("#pos-connection"); if (!node) return; const live = status === "SUBSCRIBED"; node.innerHTML = `<span class="connection-dot ${live ? "live" : "offline"}"></span>${live ? "Live" : "Offline"}`; });

  function getSubCategoryIcon(subCat) {
    const s = subCat.toLowerCase();
    if (s.includes("starter") || s.includes("appetizer")) return "ph-bowl-food";
    if (s.includes("main")) return "ph-cooking-pot";
    if (s.includes("dessert") || s.includes("sweet")) return "ph-ice-cream";
    if (s.includes("drink") || s.includes("beverage")) return "ph-wine";
    if (s.includes("bread") || s.includes("roti")) return "ph-bread";
    if (s.includes("rice") || s.includes("biryani")) return "ph-bowl-steam";
    if (s.includes("soup")) return "ph-brandy";
    if (s.includes("salad")) return "ph-carrot";
    return "ph-fork-knife";
  }

  function getAvailableSubCategories() {
    if (!activeCuisine) return [];
    const subs = new Set();
    products.forEach(p => {
      const parts = String(p.category || "").split(" - ");
      if (parts[0].trim() === activeCuisine) {
        subs.add(parts[1]?.trim() || "Others");
      }
    });
    return ["All", ...Array.from(subs)];
  }

  function renderProducts() {
    const area = mount.querySelector("#pos-dynamic-area");
    if (!area) return;

    // Evaluate action bar visibility every time the page changes
    renderActionBar();

    if (!activeCuisine && !searchTerm) {
      area.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: calc(100vh - 180px); padding-bottom: 20px;">
          ${isCustomerMode ? '' : `
            <section class="pos-toolbar-row" style="display: flex; justify-content: center; width: 100%; gap: 8px; margin-bottom: 24px; flex-wrap: nowrap; overflow-x: auto;">
              <button class="pos-toolbar-pill ${state.getState().orderType === 'dine_in' ? 'active' : ''}" data-order-type="dine_in" style="height: 44px; padding: 0 14px; font-size: 14px; font-weight: 800; gap: 7px; border-radius: 12px; border: 1px solid ${state.getState().orderType === 'dine_in' ? 'transparent' : 'var(--line)'}; white-space: nowrap; flex-shrink: 0;">
                <i class="ph-bold ph-fork-knife" style="font-size: 18px; line-height: 1;"></i>
                <span style="white-space: nowrap;">Dine-in</span>
              </button>
              <button class="pos-toolbar-pill ${state.getState().orderType === 'takeaway' ? 'active' : ''}" data-order-type="takeaway" style="height: 44px; padding: 0 14px; font-size: 14px; font-weight: 800; gap: 7px; border-radius: 12px; border: 1px solid ${state.getState().orderType === 'takeaway' ? 'transparent' : 'var(--line)'}; color: var(--forest-800); white-space: nowrap; flex-shrink: 0;">
                <i class="ph-bold ph-shopping-bag" style="font-size: 18px; color: var(--forest-800); line-height: 1;"></i>
                <span style="white-space: nowrap;">Takeaway</span>
              </button>
              <div class="pos-toolbar-pill ${!state.getState().tableId && state.getState().orderType === 'dine_in' ? '' : 'has-table'}" id="pos-table-wrap" style="height: 44px; padding: 0 14px; font-size: 14px; font-weight: 800; gap: 7px; border-radius: 12px; border: 1px solid var(--line); color: var(--forest-800); white-space: nowrap; flex-shrink: 0; cursor: pointer; transition: all 0.2s ease; ${state.getState().orderType === 'takeaway' ? 'opacity: 0.4; pointer-events: none; background: rgba(0,0,0,0.04); border-color: transparent;' : ''}">
                <span class="selected-text" id="pos-table-display" style="display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 800; color: var(--forest-800); white-space: nowrap;">
                  <i class="ph-bold ph-armchair" style="font-size: 18px; color: var(--forest-800); line-height: 1;"></i>
                  <span style="white-space: nowrap;">${state.getState().tableId && state.getState().orderType === 'dine_in' ? `Table ${tables.find(t => t.id === state.getState().tableId)?.table_no || ''}` : 'Table'}</span>
                  <i class="ph-bold ph-caret-down" style="font-size: 16px; color: var(--forest-800); line-height: 1;"></i>
                </span>
              </div>
            </section>
          `}
          <div class="drill-down-header" style="display: flex; justify-content: center; align-items: center; margin-bottom: 24px; width: 100%;">
            <h2 style="font-size: 22px; margin: 0; text-align: center;">Choose a Cuisine</h2>
          </div>
          <div class="cuisine-hero-grid" id="pos-cuisine-grid" style="width: 100%; margin: 0 auto; justify-content: center; max-width: 800px;">
            ${cuisines.map(c => `
              <div class="cuisine-hero-card" data-cuisine="${escapeHtml(c.name)}">
                <div class="cuisine-hero-bg">
                  ${c.image_url ? `<img src="${versionedAsset(c.image_url)}" alt="">` : `<div class="product-placeholder"><i class="ph ph-image"></i></div>`}
                </div>
                <div class="cuisine-hero-overlay">
                  <h3>${escapeHtml(c.name)}</h3>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `;

      area.querySelectorAll("[data-cuisine]").forEach(card => {
        card.addEventListener("click", () => {
          card.classList.add("pressed");
          setTimeout(() => {
            activeCuisine = card.dataset.cuisine;
            activeSubCategory = "All";
            searchTerm = "";
            const searchInput = mount.querySelector("#pos-search");
            if (searchInput) searchInput.value = "";
            window.history.pushState({ view: "cuisine", cuisine: activeCuisine }, "", "#" + encodeURIComponent(activeCuisine));
            renderProducts();
          }, 150);
        });
      });

      // Wire toolbar listeners for the landing view
      if (!isCustomerMode) {
        const tableWrapBtn = area.querySelector("#pos-table-wrap");
        tableWrapBtn?.addEventListener("click", () => {
          if (state.getState().orderType === "takeaway") return;
          promptTableSelection(() => {
            renderProducts(); // Re-render to update table name badge
          });
        });

        area.querySelectorAll("[data-order-type]").forEach(button => {
          button.addEventListener("click", () => {
            const oType = button.dataset.orderType;
            state.setOrderType(oType);
            if (oType === "takeaway") state.setTable(null);
            renderProducts(); // Re-render to update active pill state
          });
        });
      }

      return;
    }

    const subCategories = getAvailableSubCategories();
    
    let html = ``;
    if (!searchTerm) {
      // 100% PARITY: Slimmed Glassmorphism header
      html += `
        <div id="parity-unified-header">
          <div style="display: flex; align-items: center; gap: 10px;">
            <button id="pos-btn-back" title="Back" style="margin: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: #ffffff; border-radius: 50%; border: 1px solid rgba(0,0,0,0.04); box-shadow: 0 2px 8px rgba(0,0,0,0.06); cursor: pointer;">
              <i class="ph-bold ph-arrow-left" style="font-size: 1rem; color: var(--forest-900);"></i>
            </button>
            <h2 style="margin: 0; font-size: 1.15rem; font-weight: 800; color: var(--forest-950); letter-spacing: -0.01em; line-height: 1;">${escapeHtml(activeCuisine)}</h2>
          </div>
          <div style="position: relative;">
            <button id="pos-cat-toggle" style="margin: 0; display: flex; align-items: center; gap: 6px; padding: 0 14px; height: 32px; background: #ffffff; border: 1px solid rgba(0,0,0,0.04); box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-radius: 16px; font-weight: 700; font-size: 0.85rem; color: var(--forest-900); cursor: pointer;">
              <span>${escapeHtml(activeSubCategory)}</span>
              <i class="ph-bold ph-caret-down" style="color: var(--gold-500); font-size: 1rem;"></i>
            </button>
            <div class="sub-category-dropdown" id="pos-subcat-dropdown">
              ${subCategories.map(sub => `
                <button class="sub-category-tile ${activeSubCategory === sub ? "active" : ""}" data-sub="${escapeHtml(sub)}">
                  <i class="ph-bold ${getSubCategoryIcon(sub)}"></i>
                  <span>${escapeHtml(sub)}</span>
                </button>
              `).join("")}
            </div>
          </div>
        </div>
      `;
    } else {
      html += `
        <div id="parity-unified-header">
          <h2 style="margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--forest-950);">Search results for "${escapeHtml(searchTerm)}"</h2>
        </div>
      `;
    }

    // GAP OBLITERATED: Removed the hardcoded 'padding-top: 70px'
    html += `<section class="pos-product-container" id="pos-product-container"><div class="pos-product-grid" id="pos-product-grid"></div></section>`;
    
    area.innerHTML = html;

    area.querySelector("#pos-btn-back")?.addEventListener("click", () => {
      if (window.history.state?.view === "cuisine") {
        window.history.back(); // Triggers the popstate handler naturally
      } else {
        activeCuisine = null;
        activeSubCategory = "All";
        renderProducts();
      }
    });

    const toggleBtn = area.querySelector("#pos-cat-toggle");
    const dropdown = area.querySelector("#pos-subcat-dropdown");
    
    toggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBtn.classList.toggle("open");
      dropdown.classList.toggle("active");
    });

    document.addEventListener("click", (e) => {
      if (dropdown && !dropdown.contains(e.target) && !toggleBtn.contains(e.target)) {
        dropdown.classList.remove("active");
        toggleBtn?.classList.remove("open");
      }
    });

    area.querySelectorAll("[data-sub]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeSubCategory = btn.dataset.sub;
        dropdown?.classList.remove("active");
        toggleBtn?.classList.remove("open");
        renderProducts();
      });
    });

    const grid = area.querySelector("#pos-product-grid");
    const visible = products.filter(p => {
      const parts = String(p.category || "").split(" - ");
      const pCuisine = parts[0].trim();
      const pSub = parts[1]?.trim() || "Others";
      
      const text = `${p.name} ${p.description ?? ""} ${p.category ?? ""}`.toLowerCase();
      if (searchTerm) return text.includes(searchTerm);

      if (activeCuisine && pCuisine !== activeCuisine) return false;
      if (activeSubCategory !== "All" && pSub !== activeSubCategory) return false;
      return true;
    });

    grid.innerHTML = visible.length ? visible.map(product => `
      <article class="pos-product-card" data-product-card="${product.id}">
        <div class="pos-product-media">
          ${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="" loading="lazy">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}
          <span class="veg-mark" title="Vegetarian"><span></span></span>
        </div>
        <div class="pos-product-copy">
          <strong>${escapeHtml(product.name)}</strong>
          <span>${escapeHtml(product.category ?? "")}</span>
          ${product.description ? `<p class="pos-product-desc">${escapeHtml(product.description)}</p>` : ""}
          <div class="pos-product-bottom">
            <b>${money(product.price, settings.currency_symbol)}</b>
            <div class="premium-qty-wrapper" data-product-control="${product.id}">
              <button class="premium-qty-btn dec-btn" data-product-dec="${product.id}" title="Decrease"><i class="ph ph-minus"></i></button>
              <span class="premium-qty-value" aria-live="polite">0</span>
              <button class="premium-qty-btn inc-btn" data-product-add="${product.id}" title="Add"><i class="ph ph-plus"></i></button>
            </div>
          </div>
        </div>
      </article>
    `).join("") : `<div class="empty-state"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try another search or category.</span></div>`;

    grid.classList.remove("grid-refresh-anim");
    void grid.offsetWidth;
    grid.classList.add("grid-refresh-anim");

    area.querySelector("#pos-product-grid")?.addEventListener("click", event => {
      const add = event.target.closest("[data-product-add]");
      const inc = event.target.closest("[data-product-inc]");
      const dec = event.target.closest("[data-product-dec]");
      const card = event.target.closest("[data-product-card]"); // Capture the card click

      if (add) { const product = products.find(item => item.id === add.dataset.productAdd); if (!product) return; state.addProduct(product); animateProductControl(add); return; }
      if (inc) { state.increment(inc.dataset.productInc); animateProductControl(inc); return; }
      if (dec) { state.decrement(dec.dataset.productDec); animateProductControl(dec); }

      // OPEN OUTSTANDING PRODUCT PAGE: Triggered if user taps the card but NOT the quantity buttons
      if (card && !event.target.closest(".premium-qty-wrapper")) {
        const product = products.find(item => item.id === card.dataset.productCard);
        if (product) openProductDetailModal(product);
      }
    });

    function openProductDetailModal(product) {
      let currentQty = state.getState().items.find(i => i.id === product.id)?.quantity || 0;

      const modalBody = `
        <div class="premium-product-detail">
          <div class="detail-media">
            ${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}
            <span class="veg-mark" title="Vegetarian"><span></span></span>
          </div>
          <div class="detail-content">
            <div class="detail-price-row">
              <span class="detail-price-label">Price</span>
              <span class="detail-price-value">${money(product.price, settings.currency_symbol)}</span>
            </div>
            ${product.description ? `<p class="detail-description">${escapeHtml(product.description)}</p>` : ''}
            
            <div class="detail-action-container ${currentQty > 0 ? 'is-active' : ''}" id="detail-action-wrap">
              <button class="btn btn-primary detail-add-btn" id="detail-main-btn">
                <i class="ph-bold ph-plus"></i> Add to Order
              </button>
              
              <div class="detail-qty-ui" id="detail-qty-ui">
                <button class="detail-qty-btn" id="detail-dec"><i class="ph-bold ph-minus"></i></button>
                <span id="detail-qty-val">${currentQty}</span>
                <button class="detail-qty-btn" id="detail-inc"><i class="ph-bold ph-plus"></i></button>
              </div>

              <button class="detail-done-btn" id="detail-done-btn">
                Done <i class="ph-bold ph-check"></i>
              </button>
            </div>
          </div>
        </div>
      `;

      const modal = openAppModal({
        title: escapeHtml(product.name),
        subtitle: escapeHtml(product.category),
        body: modalBody,
        actions: [] /* Actions array cleared to remove the Done Browsing button */
      });

      const decBtn = modal.root.querySelector("#detail-dec");
      const incBtn = modal.root.querySelector("#detail-inc");
      const mainBtn = modal.root.querySelector("#detail-main-btn");
      const qtyVal = modal.root.querySelector("#detail-qty-val");
      const actionWrap = modal.root.querySelector("#detail-action-wrap");
      const doneBtn = modal.root.querySelector("#detail-done-btn");

      const updateUI = () => {
        const qty = state.getState().items.find(i => i.id === product.id)?.quantity || 0;
        qtyVal.textContent = qty;
        
        // Triggers the CSS liquid wipe transition
        if (qty > 0) {
          actionWrap.classList.add("is-active");
        } else {
          actionWrap.classList.remove("is-active");
        }
        
        // Force the background grid and footer cart to instantly sync with modal interactions!
        renderProductQuantities();
        renderActionBar();
      };

      mainBtn.addEventListener("click", () => { state.addProduct(product); updateUI(); });
      incBtn.addEventListener("click", () => { state.increment(product.id); updateUI(); });
      decBtn.addEventListener("click", () => { state.decrement(product.id); updateUI(); });
      doneBtn.addEventListener("click", () => { modal.close(); });
      
      const unsubscribe = state.subscribe(updateUI);
      const originalClose = modal.close;
      modal.close = () => { unsubscribe(); originalClose(); };
    }

    const scroller = area.querySelector("#pos-product-container");
    if (scroller) {
      let lastScroll = 0;
      scroller.addEventListener("scroll", e => {
        const current = e.target.scrollTop;
        const main = mount.querySelector(".pos-content");
        if (!main) return;
        
        // Hide headers when scrolling down past 50px
        if (current > lastScroll && current > 50) {
          main.classList.add("smart-scroll-hide");
        } 
        // Show headers when scrolling up (with a 10px buffer to prevent jitter)
        else if (current < lastScroll - 10 || current <= 0) {
          main.classList.remove("smart-scroll-hide");
        }
        lastScroll = current;
      }, { passive: true });
    }

    renderProductQuantities();
  }

  state.subscribe(current => {
    renderActionBar(current);
    renderProductQuantities(current);
  });

  renderProducts();

  function renderProductQuantities(current = state.getState()) {
    const quantities = new Map(current.items.map(item => [item.id, item.quantity]));

    mount.querySelectorAll("[data-product-control]").forEach(control => {
      const productId = control.dataset.productControl;
      const quantity = quantities.get(productId) ?? 0;
      const valSpan = control.querySelector(".premium-qty-value");

      if (quantity <= 0) {
        control.classList.remove("is-active");
        if (valSpan) valSpan.textContent = "0";
      } else {
        control.classList.add("is-active");
        if (valSpan) valSpan.textContent = quantity;
      }
    });
  }

  function animateProductControl(element) {
    const control = element.closest("[data-product-control]");
    if (!control) return;
    control.classList.remove("qty-pulse");
    void control.offsetWidth;
    control.classList.add("qty-pulse");
  }

  function renderActionBar(current = state.getState()) {
    const count = current.items.reduce((sum, i) => sum + i.quantity, 0);
    const total = current.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    
    mount.querySelector("#pos-cart-count").textContent = `${count} ${count === 1 ? "item" : "items"}`;
    
    // 100% PARITY: Exact same total text for both Staff and Customers
    mount.querySelector("#pos-cart-total").textContent = count > 0 ? `Total: ${money(total, settings.currency_symbol)}` : "Tap Next to review";
    
    mount.querySelector("#pos-next").disabled = count === 0;

    const actionBar = mount.querySelector(".pos-action-bar");
    if (actionBar) {
      if (count === 0 && !activeCuisine && !searchTerm) {
        actionBar.style.display = "none";
      } else {
        actionBar.style.display = "flex";
      }
    }
  }

  function promptTableSelection(onSelected) {
    const modal = openAppModal({
      title: "Select Table",
      subtitle: "Assign a table for this dine-in session. Occupied tables are hidden.",
      body: `<div id="table-selection-host" style="max-height: 50vh; overflow-y: auto; margin: -10px -24px;"><div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><span>Finding free tables...</span></div></div>`,
      actions: [{ label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: (ctx) => ctx.close() }]
    });

    supabase.from("dining_sessions").select("table_id").in("status", ["open", "bill_requested", "bill_ready"])
      .then(({ data: activeSessions }) => {
        const occupiedIds = new Set((activeSessions || []).map(s => s.table_id));
        const freeTables = tables.filter(t => !occupiedIds.has(t.id));
        
        const host = modal.root.querySelector("#table-selection-host");
        if (!host) return;

        host.innerHTML = freeTables.length ? freeTables.map(t => `
          <button class="btn btn-quiet table-select-btn" data-table-id="${t.id}" style="width: 100%; border-radius: 0; justify-content: flex-start; padding: 18px 24px; font-size: 16px; border-bottom: 1px solid var(--line); transition: background 0.15s;">
            <i class="ph-bold ph-armchair" style="color: var(--forest-600); margin-right: 14px; font-size: 20px;"></i>
            <strong style="color: var(--forest-950);">Table ${escapeHtml(t.table_no)}</strong>
            <span style="margin-left: auto; font-size: 13px; font-weight: 700; color: var(--muted);">${t.capacity} seats</span>
          </button>
        `).join("") : `<div class="empty-state"><i class="ph-bold ph-armchair"></i><strong>No free tables</strong><span>All tables are currently occupied.</span></div>`;

        host.querySelectorAll(".table-select-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const table = tables.find(t => t.id === btn.dataset.tableId) ?? null;
            state.setTable(table);
            modal.close();
            onSelected?.(table);
          });
        });
      })
      .catch(err => {
        console.error(err);
        const host = modal.root.querySelector("#table-selection-host");
        if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Error loading tables</strong><span>Please try again.</span></div>`;
      });
  }

  async function openReview() {
    const current = state.getState();
    
    // 1. If cart is truly empty, show warning
    if (!current.items || current.items.length === 0) { 
      showToast("Complete the order", "Add at least one dish.", "error"); 
      return; 
    }

    // 2. If items exist but table is missing for dine-in, seamlessly prompt table selection
    if (!isCustomerMode && current.orderType === "dine_in" && !current.tableId) {
      promptTableSelection(() => {
        openReview();
      });
      return;
    }
    
    const sessionKey = current.orderType === "dine_in" ? current.tableId : "takeaway_session";
    const isOpen = !!activeTableOrders[sessionKey];

    const modal = openAppModal({
      title: "Review order",
      subtitle: "Review your items before sending to the kitchen.",
      body: `<div class="pos-review-head"><div><span class="eyebrow">Order</span><strong>${current.orderType === "dine_in" ? `Dine-in · Table ${escapeHtml(tables.find(t => t.id === current.tableId)?.table_no ?? "")}` : "Takeaway"}</strong></div><span class="secure-mini"><i class="ph ph-shield-check"></i>Verified</span></div><div class="review-items">${current.items.map(item => `<div class="review-item" style="align-items: center;"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span></div><div class="premium-qty-wrapper is-active" style="flex-shrink: 0; margin-left: 12px;"><button class="premium-qty-btn dec-btn" data-dec="${item.id}" title="Decrease"><i class="ph ph-minus"></i></button><span class="premium-qty-value">${item.quantity}</span><button class="premium-qty-btn inc-btn" data-inc="${item.id}" title="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("")}</div><div class="review-total-hint"><i class="ph ph-info"></i><span>GST and the final total are calculated securely by the server.</span></div><div id="review-error-box" class="dining-warning-box" style="display: none; background: var(--danger-soft); border-color: #f1c7c4; color: var(--danger); margin-top: 12px; align-items: center;"></div>`,
      actions: [
        { label: "Keep editing", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: isOpen ? "Update Kitchen" : "Confirm order", icon: "ph-check", className: "btn-primary", onClick: async ({ close, button, root }) => { 
            button.disabled = true; 
            const originalText = button.innerHTML;
            button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i><span>Processing...</span>`;
            
            const errorBox = root.querySelector("#review-error-box");
            if (errorBox) errorBox.style.display = "none";

            const success = await submitPOSOrder(close, errorBox); 
            
            // If the order fails, instantly re-enable the button so the user isn't trapped
            if (!success) {
                button.disabled = false;
                button.innerHTML = originalText;
            }
          } 
        }
      ]
    });

    modal.root.addEventListener("click", event => { 
      const inc = event.target.closest("[data-inc]"); 
      const dec = event.target.closest("[data-dec]"); 
      if (inc) { state.increment(inc.dataset.inc); refreshReview(modal.root); } 
      if (dec) { state.decrement(dec.dataset.dec); refreshReview(modal.root); } 
    });
  }

  function refreshReview(root) {
    const current = state.getState();
    const list = root.querySelector(".review-items");
    if (!list) return;
    
    if (current.items.length === 0) {
      list.innerHTML = `<div class="empty-state compact"><i class="ph ph-shopping-cart"></i><strong>Empty</strong><span>Add items to continue.</span></div>`;
      const confirmBtn = root.querySelector(".btn-primary");
      if (confirmBtn) confirmBtn.disabled = true;
      return;
    }

    list.innerHTML = current.items.map(item => `<div class="review-item" style="align-items: center;"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span></div><div class="premium-qty-wrapper is-active" style="flex-shrink: 0; margin-left: 12px;"><button class="premium-qty-btn dec-btn" data-dec="${item.id}" title="Decrease"><i class="ph ph-minus"></i></button><span class="premium-qty-value">${item.quantity}</span><button class="premium-qty-btn inc-btn" data-inc="${item.id}" title="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("");
  }

  async function submitPOSOrder(closeModal, errorBoxElement = null) {
    if (!isCustomerMode) window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
    
    const current = state.getState();
    const posSessionKey = current.orderType === "dine_in" ? current.tableId : "takeaway_session";

    let safeServerItems = current.items.map(i => ({
      id: i.id,
      product_id: i.id,
      name: i.name,
      name_snapshot: i.name,
      price: i.price,
      unit_price: i.price,
      quantity: i.quantity
    }));

    try {
      let result;
      
      if (isCustomerMode) {
          const token = customerSessionToken || localStorage.getItem(`fourflavours.session.${current.tableId}`);
          if (!token) throw new Error("Security session expired. Please rescan the QR code.");

          const { data, error } = await supabase.rpc("submit_customer_order", {
              p_table_id: current.tableId,
              p_session_token: token,
              p_items: safeServerItems
          });
          if (error) throw error;
          result = data?.[0] ?? data;
          
      } else {
          // STAFF MODE: The backend now natively prevents duplicates and appends items!
          const { data, error } = await supabase.rpc("create_pos_order", { 
              p_order_type: current.orderType, 
              p_table_id: current.tableId, 
              p_items: safeServerItems, 
              p_note: "Staff Order" 
          });
          if (error) throw error;
          result = data?.[0] ?? data;
      }

      const wasNewOrder = !activeTableOrders[posSessionKey];
      activeTableOrders[posSessionKey] = result.id;
      state.clear();
      closeModal();
      
      if (isCustomerMode) {
          adminAlertChannel.send({ type: 'broadcast', event: 'customer_order', payload: { tableId: current.tableId, isNew: wasNewOrder } });
          showActiveOrderDashboard({ order: result, settings, current_state: current, sessionKey: posSessionKey, showPrepAnimation: true });
      } else {
          showActiveOrderDashboard({ order: result, settings, current_state: current, sessionKey: posSessionKey });
      }
      return true;

    } catch (error) {
      console.error("Order Submission Error:", error);
      if (errorBoxElement) {
          errorBoxElement.innerHTML = `<i class="ph-bold ph-warning-circle"></i><span><strong>Order failed</strong><br>${escapeHtml(error.message)}</span>`;
          errorBoxElement.style.display = "flex";
      } else {
          showToast("Order failed", error.message, "error");
      }
      return false;
    }
  }

  function showActiveOrderDashboard({ order, settings, current_state, sessionKey, showPrepAnimation = false }) {
    const t = tables.find(x => x.id === current_state.tableId);
    const titleStr = current_state.orderType === "dine_in" ? `Table ${t ? t.table_no : "Unknown"} · Live Tab` : `Takeaway · Active Order`;
    
    let displayItems = [];
    let aggregatedBill = { subtotal: 0, cgst: 0, sgst: 0, rounding: 0, grand_total: 0 };
    let rootOrder = order;
    
    let isPrepAnimating = showPrepAnimation;

    const modal = openAppModal({
      title: titleStr,
      subtitle: "Your live table tab. Add more items or request the final bill.",
      body: `<div id="active-dash-host">
        ${showPrepAnimation ? `
          <div class="inline-prep-stage">
            <div class="chef-pot-wrap">
              <div class="steam-container">
                <div class="steam-line"></div><div class="steam-line"></div><div class="steam-line"></div>
              </div>
              <i class="ph-fill ph-cooking-pot"></i>
            </div>
            <h2 class="inline-prep-title">Sending to Kitchen...</h2>
            <p class="inline-prep-subtitle">The chefs are preparing your dishes.</p>
          </div>
        ` : `
          <div class="empty-state"><i class="ph ph-spinner-gap qty-pulse"></i><span>Syncing live tab...</span></div>
        `}
      </div>`,
      actions: [
        { label: "Keep Ordering", icon: "ph-plus-circle", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: isCustomerMode ? "Request Bill" : "Complete Order", icon: "ph-receipt", className: "btn-primary", onClick: ({ close }) => {
            // UNIFIED CHECKOUT: Prompts for Final Bill Generation
            openAppModal({
              title: isCustomerMode ? "Request Final Bill?" : "Generate Final Bill?",
              subtitle: isCustomerMode ? "Your waiter will bring the physical bill to your table." : "Confirm you are finished adding items to this table.",
              body: `<div class="danger-confirm"><div class="danger-confirm-icon" style="background: var(--sage-200); color: var(--forest-900);"><i class="ph-bold ph-receipt"></i></div><h3>${isCustomerMode ? "Request Final Bill?" : "Generate Final Bill?"}</h3><p>${isCustomerMode ? "This will finalize your tab. Are you ready to pay?" : "This will finalize the tab and lock the table from further ordering."}</p></div>`,
              actions: [
                { label: "No, Go Back", className: "btn-quiet", onClick: (ctx) => ctx.close() },
                { label: isCustomerMode ? "Yes, Request Bill" : "Yes, I'm Done", className: "btn-primary", onClick: async (ctx) => {
                    if (!isCustomerMode) window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
                    ctx.button.disabled = true;
                    try {
                      if (current_state.orderType === "dine_in") {
                        if (isCustomerMode) {
                              const token = customerSessionToken || localStorage.getItem(`fourflavours.session.${current_state.tableId}`);
                              const { error: rpcError } = await supabase.rpc("request_session_bill", { p_table_id: current_state.tableId, p_session_token: token });
                              if (rpcError) throw rpcError;
                              
                              // EXPLICIT BROADCAST
                              adminAlertChannel.send({ type: 'broadcast', event: 'customer_bill', payload: { tableId: current_state.tableId } });
                              
                              // MEMORY PRESERVED: We intentionally leave the token in localStorage. 
                              // This allows the Bootstrapper to recognize them and lock them out if they go home!
                            } else {
                          const { data: sess } = await supabase.from("dining_sessions").select("id").eq("table_id", current_state.tableId).in("status", ["open", "bill_requested"]).maybeSingle();
                          if (sess) {
                            const { error: updateError } = await supabase.rpc("mark_session_bill_ready", { p_session_id: sess.id });
                            if (updateError) throw updateError;
                          }
                        }
                      }
                    } catch(e) { 
                      console.error("Failed to process bill request:", e); 
                      showToast("Action Failed", e.message || "Could not process request.", "error");
                      ctx.button.disabled = false;
                      return; // HALT EXECUTION: Never show the Thank You screen if the backend fails!
                    }
                    
                    ctx.close(); close(); 
                    delete activeTableOrders[sessionKey];
                    
                    if (isCustomerMode) {
                      // CUSTOMER UX: Shows ONLY after the database successfully records the request
                      document.getElementById("app").innerHTML = `
                        <div class="thank-you-screen">
                          <div class="thank-you-card">
                            <div class="thank-you-icon"><i class="ph-fill ph-bell-ringing"></i></div>
                            <h1 class="thank-you-title">Thank You!</h1>
                            <p class="thank-you-message">Your bill is on the way to your table.</p>
                            <div class="thank-you-divider"></div>
                            <p class="thank-you-footer">We hope you enjoyed your time at Four Flavours.<br>Please wait while our staff attends to you.</p>
                          </div>
                        </div>
                      `;
                    } else {
                      // ADMIN UX: Generate the mathematical print preview receipt as usual
                      showReceiptPreview({ 
                        order: {
                          ...rootOrder,
                          subtotal: aggregatedBill.subtotal,
                          cgst: aggregatedBill.cgst,
                          sgst: aggregatedBill.sgst,
                          rounding: aggregatedBill.rounding,
                          grand_total: aggregatedBill.grand_total
                        }, 
                        items: displayItems, 
                        settings, 
                        current_state 
                      }); 
                    }
                }}
              ]
            });
          }
        }
      ]
    });

    let syncTimer = setInterval(fetchLiveSession, 3000);
    
    // Super-Live WebSocket Hook: Fetch instantly when the database changes!
    const liveUpdateHandler = () => fetchLiveSession();
    window.addEventListener("ff_live_update", liveUpdateHandler);
    
    const originalClose = modal.close;
    modal.close = () => { 
        clearInterval(syncTimer); 
        window.removeEventListener("ff_live_update", liveUpdateHandler);
        originalClose(); 
    };

    async function fetchLiveSession() {
      const host = modal.root.querySelector("#active-dash-host");
      
      if (current_state.orderType === "takeaway") {
         if (!rootOrder || !rootOrder.id || rootOrder.id === "undefined") {
             if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><span>Connection lost. Please add a new item to restart the session.</span></div>`;
             return;
         }
         
         const { data, error } = await supabase.from("orders").select("*, order_items(*)").eq("id", rootOrder.id).single();
         if (error) {
             console.error("Takeaway Fetch Error:", error);
             if (host) host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><span>Failed to load live tab. Please close and reopen.</span></div>`;
             return;
         }
         if (data) processOrders([data]);
         return;
      }
      
      // Fetch the actual current status of the session in the database
      const { data: activeSession } = await supabase.from("dining_sessions")
         .select("id, status")
         .eq("table_id", current_state.tableId)
         .order("created_at", { ascending: false })
         .limit(1)
         .maybeSingle();

      // SECURE AUTO-CLOSE: If the session was closed by Admin, gracefully close the modal.
      // The global realtime listener will instantly transition the app to the Thank You screen!
      if (activeSession && activeSession.status === "closed") {
         modal.close();
         return; 
      }

      if (activeSession && ["open", "bill_requested", "bill_ready"].includes(activeSession.status)) {
         const { data } = await supabase.from("orders").select("*, order_items(*)").eq("session_id", activeSession.id).neq("status", "cancelled").order("created_at", { ascending: true });
         if (data) {
             // DEEP FIX 1: Restore local cache on reload so future additions append to the active order instead of creating duplicates!
             if (data.length > 0) activeTableOrders[sessionKey] = data[data.length - 1].id;
             processOrders(data);
         }
      } else {
         if (rootOrder && rootOrder.id && rootOrder.id !== "undefined") {
             const { data } = await supabase.from("orders").select("*, order_items(*)").eq("id", rootOrder.id).single();
             if (data) processOrders([data]);
         }
      }
    }

    function processOrders(ordersList) {
      let tempMap = new Map();
      aggregatedBill = { subtotal: 0, cgst: 0, sgst: 0, rounding: 0, grand_total: 0 };
      
      ordersList.forEach(o => {
        aggregatedBill.subtotal += Number(o.subtotal || 0);
        aggregatedBill.cgst += Number(o.cgst || 0);
        aggregatedBill.sgst += Number(o.sgst || 0);
        aggregatedBill.rounding += Number(o.rounding || 0);
        aggregatedBill.grand_total += Number(o.grand_total || 0);

        const itemsArray = o.items || o.order_items || []; 
        
        // Strict chronological sort ensures additions always append cleanly to the bottom
        itemsArray.sort((a, b) => (a.id || 0) - (b.id || 0));

        itemsArray.forEach(oi => {
          const pId = oi.product_id;
          const qty = Number(oi.quantity);
          if (tempMap.has(pId)) {
             tempMap.get(pId).quantity += qty;
          } else {
             const productObj = products.find(p => p.id === pId);
             tempMap.set(pId, { 
               id: pId, 
               name: productObj ? productObj.name : (oi.name_snapshot || oi.product_name || oi.name || "Unknown Item"), 
               price: oi.unit_price || oi.price, 
               quantity: qty 
             });
          }
        });
      });

      displayItems = Array.from(tempMap.values());
      renderDash();
    }

    function renderDash() {
      if (isPrepAnimating) return; // Block rendering until the chef animation finishes!
      
      const host = modal.root.querySelector("#active-dash-host");
      if (!host) return;
      
      const listContainer = host.querySelector(".dining-items-list");
      const currentScroll = listContainer ? listContainer.scrollTop : 0;

      host.innerHTML = `
        <div class="active-dining-dashboard">
          <div class="dining-status-banner">
            <i class="ph-bold ph-cooking-pot"></i>
            <div>
              <strong>Table Tab is Open</strong>
              <span id="dash-live-total">Live Total: ${money(aggregatedBill.grand_total, settings.currency_symbol)}</span>
            </div>
          </div>
          <h3 class="dining-section-title">Current Table Items <span style="font-size: 10px; font-weight: normal; color: var(--gold-600); margin-left: 8px; text-transform: uppercase;"><i class="ph-bold ph-arrows-clockwise" style="margin-right:3px;"></i>Live Sync</span></h3>
          <div class="dining-items-list" style="max-height: 40vh; overflow-y: auto;">
            ${displayItems.map(i => `
              <div class="dining-item-row">
                <div class="dining-item-info">
                  <strong>${escapeHtml(i.name)} <span class="qty-badge" id="dash-qty-${i.id}">x${i.quantity}</span></strong>
                  <span>${money(i.price, settings.currency_symbol)}</span>
                </div>
                <button class="btn-primary btn-sm dash-repeat-btn" data-id="${i.id}">
                  <i class="ph-bold ph-arrow-counter-clockwise"></i> Repeat
                </button>
              </div>
            `).join("")}
          </div>
        </div>
      `;

      host.querySelectorAll(".dash-repeat-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
          btn.classList.remove("qty-pulse"); void btn.offsetWidth; btn.classList.add("qty-pulse");
          const productId = btn.dataset.id;
          
          try {
            btn.disabled = true;
            const p = products.find(x => x.id === productId);
            if (!p) throw new Error("Item not found in menu.");
            
            // UNIFIED REPEAT LOGIC: Completely bypasses the broken Customer RPC and uses the clean Append RPC
            await supabase.rpc("append_pos_order", { 
                p_order_id: rootOrder.id, 
                p_items: [{ id: productId, name: p.name, price: p.price, quantity: 1 }] 
            });
            
            await fetchLiveSession(); 
          } catch(e) { 
            console.error("Sync failed:", e); 
            showToast("Repeat failed", "Could not repeat this item.", "error");
          } finally { 
            btn.disabled = false; 
          }
        });
      });

      const newListContainer = host.querySelector(".dining-items-list");
      if (newListContainer) newListContainer.scrollTop = currentScroll;
    }

    // Delay the reveal exactly until the animation concludes
    if (isPrepAnimating) {
        setTimeout(() => {
            isPrepAnimating = false;
            if (displayItems.length > 0) renderDash(); // Render instantly now that animation is done
        }, 2800);
    }
    
    fetchLiveSession(); // Fetches in the background while the animation plays!
  }

  async function showReceiptPreview({ order, items, settings, current_state }) {
    let tableString = "Takeaway";
    if (current_state && current_state.orderType === "dine_in" && current_state.tableId) {
      const t = tables.find(x => x.id === current_state.tableId);
      if (t) tableString = `Dine-in · Table ${t.table_no}`;
    }

    const date = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const receiptHTML = `
      <article class="thermal-receipt" id="thermal-receipt-content">
        <header class="thermal-head">
          <img class="thermal-logo" src="${versionedAsset("assets/images/website_icon.svg")}" alt="Logo">
          <h1>${escapeHtml(settings.restaurant_name)}</h1>
          ${settings.restaurant_address ? `<p>${escapeHtml(settings.restaurant_address).replace(/\n/g, '<br>')}</p>` : ''}
          ${settings.gst_number ? `<p><strong>GSTIN:</strong> ${escapeHtml(settings.gst_number)}</p>` : ''}
        </header>
        <div class="thermal-meta">
          <div><span>Order:</span> <strong>#${escapeHtml(order.order_number)}</strong></div>
          <div><span>Date:</span> <strong>${date}</strong></div>
          <div><span>Type:</span> <strong>${escapeHtml(tableString)}</strong></div>
        </div>
        <table class="thermal-items-table">
          <thead>
            <tr>
              <th style="text-align: left;">Item</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(i => `
              <tr>
                <td style="text-align: left;">${escapeHtml(i.name)}<br><small>${money(i.price, settings.currency_symbol)}</small></td>
                <td style="text-align: center;">${i.quantity}</td>
                <td style="text-align: right;">${money(Number(i.price) * Number(i.quantity), settings.currency_symbol)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="thermal-totals-wrap">
          <div class="thermal-line"><span>Subtotal</span><strong>${money(order.subtotal, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>CGST (${settings.cgst_rate}%)</span><strong>${money(order.cgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>SGST (${settings.sgst_rate}%)</span><strong>${money(order.sgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>Rounding</span><strong>${money(order.rounding, settings.currency_symbol)}</strong></div>
          <div class="thermal-line thermal-grand"><span>GRAND TOTAL</span><strong>${money(order.grand_total, settings.currency_symbol)}</strong></div>
        </div>
        ${settings.upi_id ? `
          <div class="thermal-payment-block">
            <div class="thermal-qr" id="thermal-upi"></div>
            <div class="thermal-upi-note"><strong>Scan to pay</strong><br>Supported by all UPI apps</div>
          </div>
        ` : ""}
        <footer class="thermal-foot">
          <p>${escapeHtml(settings.receipt_footer || 'Thank you for dining with us!')}</p>
          <div class="thermal-software-tag">Powered by Four Flavours POS</div>
        </footer>
      </article>
    `;

    const modal = openAppModal({
      title: isCustomerMode ? "Your Digital Bill" : `Order #${order.order_number} Confirmed`,
      subtitle: isCustomerMode ? "Please pay at the counter or show this to your waiter." : "Review the generated bill before printing.",
      body: `<div class="receipt-preview-container">${receiptHTML}</div>`,
      actions: isCustomerMode ? [
        { label: "Exit Receipt", icon: "ph-check", className: "btn-primary", onClick: ({ close }) => { close(); window.location.reload(); } }
      ] : [
        { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Print Bill", icon: "ph-printer", className: "btn-primary", onClick: () => {
            const host = document.querySelector("#receipt-print-host");
            if (host) {
              host.innerHTML = modal.root.querySelector("#thermal-receipt-content").outerHTML;
              window.print();
            }
        }}
      ]
    });

    if (settings.upi_id && globalThis.QRCode) {
      setTimeout(() => {
        const qr = modal.root.querySelector("#thermal-upi");
        if (qr) {
          qr.innerHTML = "";
          const pa = encodeURIComponent(settings.upi_id.trim());
          const pn = encodeURIComponent(settings.restaurant_name.trim());
          const am = Number(order.grand_total).toFixed(2);
          const tn = encodeURIComponent(`Order #${order.order_number}`);
          const upiString = `upi://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`;
          new QRCode(qr, { text: upiString, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
        }
      }, 50);
    }
  }

  async function openOrdersDrawer() {
    unreadOrders = 0;
    unseenBillRequests = 0;
    const badge = mount.querySelector("#pos-order-badge"); 
    const bellIcon = mount.querySelector("#pos-orders");
    
    if (badge) { 
      badge.classList.add("hidden"); 
      badge.textContent = "0"; 
      badge.style.background = "var(--gold-500)"; // Reset to default
      badge.style.color = "var(--forest-950)";
    }
    if (bellIcon) {
      bellIcon.style.borderColor = "var(--forest-700)"; // Reset to default
    }
    const { data: sessions, error } = await supabase.from("dining_sessions").select("*").neq("status", "closed").order("bill_requested_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
    if (error) return showToast("Could not load table orders", error.message, "error");

    const modal = openAppModal({
      title: "Table orders",
      subtitle: "Customer rounds stay together until the final payment.",
      body: `<div class="session-scroll-container">${sessions?.length ? sessions.map(s => `<article class="session-card ${s.status === 'bill_requested' ? 'bill-requested-card' : ''}"><div class="session-card-head"><div><span class="eyebrow">Table</span><h3>${escapeHtml(tables.find(t => t.id === s.table_id)?.table_no ?? "—")}</h3></div><span class="session-status ${s.status}"><i class="ph ph-${s.status === "bill_requested" ? "receipt" : s.status === "bill_ready" ? "check-circle" : "clock"}"></i>${s.status === "bill_requested" ? "Bill requested" : s.status === "bill_ready" ? "Bill ready" : "Open"}</span></div><div class="session-summary" data-session-summary="${s.id}"><span>Loading…</span></div><div class="session-actions">${s.status === "bill_requested" ? `<button class="btn btn-primary btn-small" data-ready-bill="${s.id}"><i class="ph ph-receipt"></i>Prepare bill</button>` : ""}${s.status === "bill_ready" ? `<button class="btn btn-dark btn-small" data-close-session="${s.id}"><i class="ph ph-check"></i>Complete payment</button>` : ""}</div></article>`).join("") : `<div class="empty-state"><i class="ph ph-bell-slash"></i><strong>No open customer sessions</strong><span>New QR orders appear here automatically.</span></div>`}</div>`,
      actions: [{ label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() }]
    });

    for (const s of sessions ?? []) {
      const target = modal.root.querySelector(`[data-session-summary="${s.id}"]`); if (!target) continue;
      const { data: orders } = await supabase.from("orders").select("id, order_number, order_items(quantity)").eq("session_id", s.id).neq("status", "cancelled").order("created_at", { ascending: true });
      const list = orders ?? [];
      const items = list.reduce((sum, o) => sum + (o.order_items ?? []).reduce((n, i) => n + Number(i.quantity || 0), 0), 0);
      target.innerHTML = `<div><strong>${list.length}</strong><span>${list.length === 1 ? "round" : "rounds"}</span></div><div><strong>${items}</strong><span>${items === 1 ? "item" : "items"}</span></div>`;
    }

    modal.root.addEventListener("click", async event => {
      const ready = event.target.closest("[data-ready-bill]");
      const complete = event.target.closest("[data-close-session]");
      if (ready) await prepareBill(ready.dataset.readyBill, ready, modal.close);
      if (complete) await completeSession(complete.dataset.closeSession, complete, modal.close);
    });
  }

  async function prepareBill(sessionId, button, closeOrdersDrawer) {
    window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
    button.disabled = true;
    try {
      const { error } = await supabase.rpc("mark_session_bill_ready", { p_session_id: sessionId });
      if (error) throw error;
      showToast("Bill ready", "The customer can now view the final bill.");
      closeOrdersDrawer?.();
      await openOrdersDrawer();
    } catch (error) { button.disabled = false; showToast("Could not prepare bill", error.message, "error"); }
  }

  async function completeSession(sessionId, button, closeOrdersDrawer) {
    const paymentModal = openAppModal({
      title: "Complete payment",
      subtitle: "Close the dining session after settlement.",
      body: `<div class="payment-choice-grid"><button class="payment-choice" data-payment="cash"><i class="ph ph-money"></i><span>Cash</span></button><button class="payment-choice" data-payment="upi"><i class="ph ph-device-mobile"></i><span>UPI</span></button><button class="payment-choice" data-payment="card"><i class="ph ph-credit-card"></i><span>Card</span></button></div><div class="review-total-hint"><i class="ph ph-info"></i><span>Closing this session means no further rounds should be added to this table visit.</span></div>`,
      actions: [{ label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() }]
    });
    paymentModal.root.querySelectorAll(".payment-choice").forEach(choice => choice.addEventListener("click", async () => {
      window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
      paymentModal.root.querySelectorAll(".payment-choice").forEach(el => el.disabled = true);
      try {
        const { error } = await supabase.rpc("complete_session_payment", { p_session_id: sessionId, p_payment_method: choice.dataset.payment });
        if (error) throw error;
        paymentModal.close();
        closeOrdersDrawer?.();
        showToast("Table closed", "Payment recorded and dining session completed.");
        await openOrdersDrawer();
      } catch (error) { paymentModal.root.querySelectorAll(".payment-choice").forEach(el => el.disabled = false); showToast("Could not complete payment", error.message, "error"); }
    }));
  }

  return async () => { 
    window.removeEventListener("popstate", handlePopState);
    document.removeEventListener("click", handleOutsideClick); 
    drawerCleanup?.(); 
    if (realtimeChannel) { try { await supabase.removeChannel(realtimeChannel); } catch {} } 
  };
}