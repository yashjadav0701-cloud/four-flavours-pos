import { supabase } from "../core/supabase.js";
import { DEFAULT_SETTINGS, versionedAsset } from "../core/config.js";
import { createPOSState } from "../core/posState.js";
import { escapeHtml, money, mountNavigation, openAppModal, showToast } from "../components/navigation.js";

export async function render({ mount }) {
  if (!supabase) {
    mount.innerHTML = `<section class="access-screen dark-access"><div class="access-card"><img class="access-logo" src="${versionedAsset("assets/images/website_icon.png")}" alt=""><h1>Four Flavours POS</h1><p>Supabase configuration is missing.</p></div></section>`;
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
  const tables = tablesResult.data ?? [];
  const cuisines = cuisinesResult.data ?? [];
  const state = createPOSState({ settings });
  
  let activeCuisine = null;
  let activeSubCategory = "All";
  let searchTerm = "";
  let drawerCleanup = null;
  let realtimeChannel = null;
  let unreadOrders = 0;

  mount.innerHTML = `
    <section class="pos-page">
      <header class="app-topbar pos-topbar">
        <div class="topbar-side topbar-left"><button class="icon-btn icon-btn-dark" id="pos-menu" title="Open menu" aria-label="Open menu"><i class="ph ph-list"></i></button><div class="connection-pill" id="pos-connection"><span class="connection-dot live"></span>Live</div></div>
        <div class="brand-center pos-brand-center main-logo-only">
          <img src="${versionedAsset("assets/images/website_logo.png")}" alt="Four Flavours" />
        </div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="pos-search-toggle" title="Search"><i class="ph ph-magnifying-glass"></i></button>
          <button class="icon-btn icon-btn-dark icon-badge-btn" id="pos-orders" title="Table orders" aria-label="Table orders"><i class="ph ph-bell"></i><span class="icon-badge hidden" id="pos-order-badge">0</span></button>
        </div>
      </header>
      
      <div class="pos-search-overlay" id="pos-search-overlay">
        <i class="ph ph-magnifying-glass"></i>
        <input id="pos-search" class="search-input" type="search" placeholder="Search dishes..." autocomplete="off">
      </div>

      <main class="pos-content">
        <section class="pos-toolbar-row">
          <button class="pos-toolbar-pill active" data-order-type="dine_in"><i class="ph-bold ph-armchair"></i><span>Dine-in</span></button>
          <button class="pos-toolbar-pill" data-order-type="takeaway"><i class="ph-bold ph-shopping-bag"></i><span>Takeaway</span></button>
          <div class="pos-toolbar-pill" id="pos-table-wrap">
            <span class="selected-text" id="pos-table-display"><i class="ph-bold ph-armchair"></i><span>Table</span><i class="ph ph-caret-down"></i></span>
            <select id="pos-table"><option value="">Select Table</option>${tables.map(t => `<option value="${t.id}">Table ${escapeHtml(t.table_no)}</option>`).join("")}</select>
          </div>
        </section>
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
  mount.querySelector("#pos-menu").addEventListener("click", () => window.__FOUR_FLAVOURS_NAV__?.open());
  
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
  
  const tableDisplay = mount.querySelector("#pos-table-display span");
  mount.querySelector("#pos-table").addEventListener("change", event => { 
    const table = tables.find(t => t.id === event.target.value) ?? null; 
    state.setTable(table); 
    tableDisplay.textContent = table ? `Table ${table.table_no}` : "Table";
  });
  
  mount.querySelectorAll("[data-order-type]").forEach(button => button.addEventListener("click", () => { 
    state.setOrderType(button.dataset.orderType); 
    mount.querySelectorAll("[data-order-type]").forEach(el => el.classList.toggle("active", el === button)); 
    mount.querySelector("#pos-table-wrap").classList.toggle("is-disabled", button.dataset.orderType === "takeaway"); 
    if (button.dataset.orderType === "takeaway") {
      mount.querySelector("#pos-table").value = "";
      tableDisplay.textContent = "Table";
    }
  }));
  
  mount.querySelector("#pos-next").addEventListener("click", openReview);
  mount.querySelector("#pos-orders").addEventListener("click", openOrdersDrawer);

  realtimeChannel = supabase.channel(`live-orders-${crypto.randomUUID()}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, payload => {
      if (payload.new?.source !== "customer") return;
      unreadOrders += 1;
      const badge = mount.querySelector("#pos-order-badge");
      badge.textContent = String(unreadOrders);
      badge.classList.remove("hidden");
      showToast("New table order", `Order #${payload.new.order_number} has arrived.`);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dining_sessions" }, payload => {
      if (payload.new?.status === "bill_requested") showToast("Bill requested", "A table is waiting for the final bill.");
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
        <div class="drill-down-header" style="margin-top: 14px;">
          <h2>Choose a Cuisine</h2>
        </div>
        <div class="cuisine-hero-grid" id="pos-cuisine-grid">
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
      `;

      area.querySelectorAll("[data-cuisine]").forEach(card => {
        card.addEventListener("click", () => {
          activeCuisine = card.dataset.cuisine;
          activeSubCategory = "All";
          searchTerm = "";
          mount.querySelector("#pos-search").value = "";
          renderProducts();
        });
      });
      return;
    }

    const subCategories = getAvailableSubCategories();
    
    let html = ``;
    if (!searchTerm) {
      html += `
        <div class="sticky-subcat-wrap" id="pos-sticky-wrap">
          <div class="sticky-subcat-inner">
            <div class="drill-down-header" style="margin-top: 14px;">
              <button class="btn btn-quiet" id="pos-btn-back"><i class="ph ph-arrow-left"></i>Cuisines</button>
              <h2>${escapeHtml(activeCuisine)}</h2>
            </div>
            <div class="sub-category-grid" id="pos-subcat-grid">
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
      html += `<div class="drill-down-header" style="margin-top: 14px;"><h2>Search results for "${escapeHtml(searchTerm)}"</h2></div>`;
    }

    html += `<section class="pos-product-container" id="pos-product-container"><div class="pos-product-grid" id="pos-product-grid"></div></section>`;
    
    area.innerHTML = html;

    area.querySelector("#pos-btn-back")?.addEventListener("click", () => {
      activeCuisine = null;
      activeSubCategory = "All";
      renderProducts();
    });

    area.querySelectorAll("[data-sub]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeSubCategory = btn.dataset.sub;
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
          <div class="pos-product-bottom">
            <b>${money(product.price, settings.currency_symbol)}</b>
            <span class="product-qty-control" data-product-control="${product.id}"></span>
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

      if (add) { const product = products.find(item => item.id === add.dataset.productAdd); if (!product) return; state.addProduct(product); animateProductControl(add); return; }
      if (inc) { state.increment(inc.dataset.productInc); animateProductControl(inc); return; }
      if (dec) { state.decrement(dec.dataset.productDec); animateProductControl(dec); }
    });

    const scroller = area.querySelector("#pos-product-container");
    if (scroller) {
      let lastScroll = 0;
      scroller.addEventListener("scroll", e => {
        const wrap = area.querySelector("#pos-sticky-wrap");
        if (!wrap) return;
        const current = e.target.scrollTop;
        if (current > lastScroll && current > 40) wrap.classList.add("hidden-up");
        else if (current < lastScroll) wrap.classList.remove("hidden-up");
        lastScroll = current;
      });
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

      if (quantity <= 0) {
        control.className = "product-qty-control";
        control.innerHTML = `
          <button class="product-add-btn-single" data-product-add="${productId}" title="Add to order" aria-label="Add to order">
            <i class="ph ph-plus"></i>
          </button>
        `;
        return;
      }

      control.className = "product-qty-control is-active";
      control.innerHTML = `
        <button class="product-qty-btn" data-product-dec="${productId}" title="Decrease quantity" aria-label="Decrease quantity">
          <i class="ph ph-minus"></i>
        </button>
        <span class="product-qty-value" aria-live="polite">${quantity}</span>
        <button class="product-qty-btn" data-product-inc="${productId}" title="Increase quantity" aria-label="Increase quantity">
          <i class="ph ph-plus"></i>
        </button>
      `;
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
    mount.querySelector("#pos-cart-total").textContent = count > 0 ? `Total: ${money(total, settings.currency_symbol)}` : "Tap Next to review";
    
    // Ensure the button is never natively disabled so clicks register and trigger validation feedback!
    mount.querySelector("#pos-next").disabled = false;

    const actionBar = mount.querySelector(".pos-action-bar");
    if (actionBar) {
      // Hide bar on the main cuisines page ONLY if the cart is completely empty.
      if (count === 0 && !activeCuisine && !searchTerm) {
        actionBar.style.display = "none";
      } else {
        actionBar.style.display = "flex";
      }
    }
  }

  function openReview() {
    const current = state.getState();
    if (!state.canSubmit()) { 
      showToast("Complete the order", current.orderType === "dine_in" && !current.tableId ? "Choose a table first." : "Add at least one dish.", "error"); 
      return; 
    }
    
    const modal = openAppModal({
      title: "Review order",
      subtitle: "Bill details stay out of the main POS screen.",
      body: `<div class="pos-review-head"><div><span class="eyebrow">Order</span><strong>${current.orderType === "dine_in" ? `Dine-in · Table ${escapeHtml(tables.find(t => t.id === current.tableId)?.table_no ?? "")}` : "Takeaway"}</strong></div><span class="secure-mini"><i class="ph ph-shield-check"></i>Verified</span></div><div class="review-items">${current.items.map(item => `<div class="review-item"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)} ×${item.quantity}</span></div><div class="review-item-actions"><button class="quantity-btn" data-dec="${item.id}" title="Decrease" aria-label="Decrease"><i class="ph ph-minus"></i></button><strong>${item.quantity}</strong><button class="quantity-btn" data-inc="${item.id}" title="Increase" aria-label="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("")}</div><div class="review-total-hint"><i class="ph ph-info"></i><span>GST and the final total are calculated securely by the server.</span></div>`,
      actions: [
        { label: "Keep editing", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Confirm order", icon: "ph-check", className: "btn-primary", onClick: async ({ close, button }) => { button.disabled = true; await submitPOSOrder(close); } }
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

    list.innerHTML = current.items.map(item => `<div class="review-item"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)} × ${item.quantity}</span></div><div class="review-item-actions"><button class="quantity-btn" data-dec="${item.id}" title="Decrease" aria-label="Decrease"><i class="ph ph-minus"></i></button><strong>${item.quantity}</strong><button class="quantity-btn" data-inc="${item.id}" title="Increase" aria-label="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("");
  }

  async function submitPOSOrder(closeModal) {
    const current = state.getState();
    try {
      const { data, error } = await supabase.rpc("create_pos_order", { p_order_type: current.orderType, p_table_id: current.tableId, p_items: state.toServerItems(), p_note: null });
      if (error) throw error;
      const result = data?.[0] ?? data;
      if (!result?.order_number) throw new Error("The restaurant did not return an order number.");
      state.clear(); 
      closeModal(); 
      showToast("Order confirmed", `Order #${result.order_number} is ready for service.`); 
      
      // Pass the known current_state down so we don't rely on the database response for the table number
      showReceiptPreview({ order: result, items: current.items, settings, current_state: current });
    } catch (error) { showToast("Order failed", error.message, "error"); }
  }

  async function showReceiptPreview({ order, items, settings, current_state }) {
    let tableString = "Takeaway";
    if (current_state && current_state.orderType === "dine_in" && current_state.tableId) {
      const t = tables.find(x => x.id === current_state.tableId);
      if (t) tableString = `Dine-in · Table ${t.table_no}`;
    }

    const date = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    // This is the exact DOM structure that will be printed
    const receiptHTML = `
      <article class="thermal-receipt" id="thermal-receipt-content">
        <header class="thermal-head">
          <img class="thermal-logo" src="${versionedAsset("assets/images/website_icon.png")}" alt="Logo">
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
      title: `Order #${order.order_number} Confirmed`,
      subtitle: "Review the generated bill before printing.",
      body: `<div class="receipt-preview-container">${receiptHTML}</div>`,
      actions: [
        { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Print Bill", icon: "ph-printer", className: "btn-primary", onClick: () => {
            const host = document.querySelector("#receipt-print-host");
            if (host) {
              // Copy the fully rendered HTML (including the QR canvas) to the print host
              host.innerHTML = modal.root.querySelector("#thermal-receipt-content").outerHTML;
              window.print();
            }
        }}
      ]
    });

    if (settings.upi_id && globalThis.QRCode) {
      const qr = modal.root.querySelector("#thermal-upi"); 
      const url = new URL("upi://pay"); 
      url.searchParams.set("pa", settings.upi_id); 
      url.searchParams.set("pn", settings.restaurant_name); 
      url.searchParams.set("am", Number(order.grand_total).toFixed(2)); 
      url.searchParams.set("cu", "INR"); 
      url.searchParams.set("tn", `Order #${order.order_number}`);
      new QRCode(qr, { text: url.toString(), width: 140, height: 140, correctLevel: QRCode.CorrectLevel.L });
    }
  }

  async function openOrdersDrawer() {
    unreadOrders = 0;
    const badge = mount.querySelector("#pos-order-badge"); badge.classList.add("hidden"); badge.textContent = "0";
    const { data: sessions, error } = await supabase.from("dining_sessions").select("*").neq("status", "closed").order("bill_requested_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
    if (error) return showToast("Could not load table orders", error.message, "error");

    const modal = openAppModal({
      title: "Table orders",
      subtitle: "Customer rounds stay together until the final payment.",
      body: `<div class="session-scroll-container">${sessions?.length ? sessions.map(s => `<article class="session-card"><div class="session-card-head"><div><span class="eyebrow">Table</span><h3>${escapeHtml(tables.find(t => t.id === s.table_id)?.table_no ?? "—")}</h3></div><span class="session-status ${s.status}"><i class="ph ph-${s.status === "bill_requested" ? "receipt" : s.status === "bill_ready" ? "check-circle" : "clock"}"></i>${s.status === "bill_requested" ? "Bill requested" : s.status === "bill_ready" ? "Bill ready" : "Open"}</span></div><div class="session-summary" data-session-summary="${s.id}"><span>Loading…</span></div><div class="session-actions">${s.status === "bill_requested" ? `<button class="btn btn-primary btn-small" data-ready-bill="${s.id}"><i class="ph ph-receipt"></i>Prepare bill</button>` : ""}${s.status === "bill_ready" ? `<button class="btn btn-dark btn-small" data-close-session="${s.id}"><i class="ph ph-check"></i>Complete payment</button>` : ""}</div></article>`).join("") : `<div class="empty-state"><i class="ph ph-bell-slash"></i><strong>No open customer sessions</strong><span>New QR orders appear here automatically.</span></div>`}</div>`,
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

  async function printReceipt({ order, items, settings }) {
    const host = document.querySelector("#receipt-print-host"); if (!host) return;
    
    let tableString = "Takeaway";
    if (order.order_type === "dine_in" && order.table_id) {
      const t = tables.find(x => x.id === order.table_id);
      if (t) tableString = `Dine-in · Table ${t.table_no}`;
    }

    const date = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    host.innerHTML = `
      <article class="thermal-receipt">
        <header class="thermal-head">
          <img class="thermal-logo" src="${versionedAsset("assets/images/website_logo.png")}" alt="Logo">
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

    if (settings.upi_id && globalThis.QRCode) {
      const qr = host.querySelector("#thermal-upi"); 
      const url = new URL("upi://pay"); 
      url.searchParams.set("pa", settings.upi_id); 
      url.searchParams.set("pn", settings.restaurant_name); 
      url.searchParams.set("am", Number(order.grand_total).toFixed(2)); 
      url.searchParams.set("cu", "INR"); 
      url.searchParams.set("tn", `Order #${order.order_number}`);
      new QRCode(qr, { text: url.toString(), width: 140, height: 140, correctLevel: QRCode.CorrectLevel.L });
      await new Promise(requestAnimationFrame);
    }
    window.print();
  }

  return async () => { document.removeEventListener("click", handleOutsideClick); drawerCleanup?.(); if (realtimeChannel) { try { await supabase.removeChannel(realtimeChannel); } catch {} } };
}