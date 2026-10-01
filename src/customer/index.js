import { supabase } from "../core/supabase.js";
import { DEFAULT_SETTINGS, versionedAsset } from "../core/config.js";
import { createPOSState } from "../core/posState.js";
import { escapeHtml, money, openAppModal, showToast } from "../components/navigation.js";

const STORAGE_PREFIX = "fourflavours.session.";

export async function render({ mount, route }) {
  if (!supabase) {
    mount.innerHTML = `<main class="customer-page"><section class="customer-message"><img src="${versionedAsset("assets/images/website_icon.png")}" alt=""><h1>Menu unavailable</h1><p>Restaurant configuration is incomplete.</p></section></main>`;
    return () => {};
  }

  const tableId = route.tableId;
  const [tableResult, productsResult, cuisinesResult] = await Promise.all([
    supabase.from("tables").select("id, table_no").eq("id", tableId).eq("is_active", true).maybeSingle(),
    supabase.from("products").select("*").eq("is_active", true).order("sort_order", { ascending: true }).order("name", { ascending: true }),
    supabase.from("cuisines").select("*").order("sort_order", { ascending: true })
  ]);

  if (tableResult.error) throw tableResult.error;
  if (productsResult.error) throw productsResult.error;

  const table = tableResult.data;
  const products = productsResult.data ?? [];
  const cuisines = cuisinesResult.data ?? [];
  const restaurantName = DEFAULT_SETTINGS.restaurant_name;

  if (!table) {
    mount.innerHTML = `<main class="customer-page"><section class="customer-message"><div class="message-mark"><i class="ph ph-qr-code"></i></div><span class="eyebrow">Four Flavours</span><h1>Table unavailable</h1><p>This QR code is no longer active.</p></section></main>`;
    return () => {};
  }

  const sessionKey = `${STORAGE_PREFIX}${table.id}`;
  const { data: sessionBootstrap, error: sessionError } = await supabase.rpc("ensure_customer_session", { p_table_id: table.id });
  if (sessionError) throw sessionError;
  const session = sessionBootstrap?.[0] ?? sessionBootstrap;
  if (!session?.session_token) throw new Error("Unable to create a dining session.");
  localStorage.setItem(sessionKey, session.session_token);

  const state = createPOSState({ orderType: "dine_in", tableId: table.id });

  let activeCuisine = null;
  let activeSubCategory = "All";
  let sessionStatus = session.status || "open";
  let lastOrderNumber = null;
  let pollingTimer = null;
  let lenis = null;

  mount.innerHTML = `
    <main class="customer-page">
      <header class="customer-topbar">
        <div class="customer-top-side"><span class="table-pill"><i class="ph ph-table"></i>Table ${escapeHtml(table.table_no)}</span></div>
        <div class="customer-brand-center customer-main-logo">
          <img
            src="${versionedAsset("assets/images/website_logo.png")}"
            alt="Four Flavours"
          />
        </div>
        <div class="customer-top-side customer-top-side-right"><span class="live-indicator"><span class="live-dot"></span>Live menu</span></div>
      </header>
      <section id="customer-stage" class="customer-stage"></section>
    </main>`;

  if (globalThis.Lenis) {
    lenis = new Lenis({ autoRaf: true, smoothWheel: true, lerp: 0.085 });
  }

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

  function renderMenu() {
    stopPolling();
    const stage = mount.querySelector("#customer-stage");
    
    let html = `<div class="customer-menu-shell">`;

    if (!activeCuisine) {
      html += `
        <div class="drill-down-header">
          <h2>Choose a Cuisine</h2>
        </div>
        <div class="cuisine-hero-grid">
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
    } else {
      const subCategories = getAvailableSubCategories();
      html += `
        <div class="sticky-subcat-wrap" id="sticky-subcat-wrap">
          <div class="sticky-subcat-inner">
            <div class="drill-down-header">
              <button class="btn btn-quiet" id="btn-back-cuisines"><i class="ph ph-arrow-left"></i>Cuisines</button>
              <h2>${escapeHtml(activeCuisine)}</h2>
            </div>
            <div class="sub-category-grid">
              ${subCategories.map(sub => `
                <button class="sub-category-tile ${activeSubCategory === sub ? "active" : ""}" data-sub="${escapeHtml(sub)}">
                  <i class="ph-bold ${getSubCategoryIcon(sub)}"></i>
                  <span>${escapeHtml(sub)}</span>
                </button>
              `).join("")}
            </div>
          </div>
        </div>
        <section class="customer-product-scroll" id="customer-product-scroll">
          <div class="customer-product-grid" id="customer-product-grid"></div>
        </section>
      `;
    }

    html += `</div>
      <div class="customer-order-bar">
        <div class="customer-order-bar-copy"><div class="order-count-icon"><i class="ph ph-shopping-bag"></i></div><div><strong id="customer-cart-count">0 items</strong><span>Ready for review</span></div></div>
        <button class="btn btn-primary btn-review" id="customer-review" disabled title="Review your order"><span>Next</span><i class="ph ph-arrow-right"></i></button>
      </div>`;
    
    stage.innerHTML = html;

    if (activeCuisine) {
      renderProducts();
      
      stage.querySelector("#btn-back-cuisines")?.addEventListener("click", () => {
        activeCuisine = null;
        activeSubCategory = "All";
        renderMenu();
      });

      stage.querySelectorAll("[data-sub]").forEach(btn => {
        btn.addEventListener("click", () => {
          activeSubCategory = btn.dataset.sub;
          renderMenu(); 
        });
      });

      stage.querySelector("#customer-product-grid")?.addEventListener("click", event => {
        const add = event.target.closest("[data-product-add]");
        const inc = event.target.closest("[data-product-inc]");
        const dec = event.target.closest("[data-product-dec]");
        if (add) { const product = products.find(item => item.id === add.dataset.productAdd); if (product) { state.addProduct(product); animateProductControl(add); } return; }
        if (inc) { state.increment(inc.dataset.productInc); animateProductControl(inc); return; }
        if (dec) { state.decrement(dec.dataset.productDec); animateProductControl(dec); }
      });

      const scroller = stage.querySelector("#customer-product-scroll");
      if (scroller) {
        let lastScroll = 0;
        scroller.addEventListener("scroll", e => {
          const wrap = stage.querySelector("#sticky-subcat-wrap");
          if (!wrap) return;
          const current = e.target.scrollTop;
          if (current > lastScroll && current > 40) wrap.classList.add("hidden-up");
          else if (current < lastScroll) wrap.classList.remove("hidden-up");
          lastScroll = current;
        });
      }
    } else {
      stage.querySelectorAll("[data-cuisine]").forEach(card => {
        card.addEventListener("click", () => {
          activeCuisine = card.dataset.cuisine;
          activeSubCategory = "All";
          renderMenu();
        });
      });
    }

    stage.querySelector("#customer-review")?.addEventListener("click", openReview);
    renderOrderBar(state.getState());
  }

  if (!mount._hasSubscribed) {
    state.subscribe(current => {
      renderOrderBar(current);
      renderProductQuantities(current);
    });
    mount._hasSubscribed = true;
  }

  function renderProducts() {
    const grid = mount.querySelector("#customer-product-grid");
    if (!grid) return;
    const visible = products.filter(p => {
      const parts = String(p.category || "").split(" - ");
      const pCuisine = parts[0].trim();
      const pSub = parts[1]?.trim() || "Others";
      
      if (activeCuisine && pCuisine !== activeCuisine) return false;
      if (activeSubCategory !== "All" && pSub !== activeSubCategory) return false;
      return true;
    });

    grid.innerHTML = visible.length ? visible.map(product => `
      <article class="customer-product-card">
        <div class="customer-product-media">
          ${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="${escapeHtml(product.name)}" loading="lazy">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}
          <span class="product-category-tag">${escapeHtml(product.category ?? "")}</span>
        </div>
        <div class="customer-product-copy">
          <div class="customer-product-top">
            <h2>${escapeHtml(product.name)}</h2>
            <strong>${money(product.price)}</strong>
          </div>
          <p>${escapeHtml(product.description || "Freshly prepared in the Four Flavours kitchen.")}</p>
          <div class="customer-product-bottom">
            <span class="customer-qty-control" data-product-control="${product.id}"></span>
          </div>
        </div>
      </article>
    `).join("") : `<div class="empty-state"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try another category.</span></div>`;

    // Restart the CSS animation to show loading flash
    grid.classList.remove("grid-refresh-anim");
    void grid.offsetWidth; // Force a reflow
    grid.classList.add("grid-refresh-anim");

    renderProductQuantities();
  }

  function renderProductQuantities(current = state.getState()) {
    const quantities = new Map(
      current.items.map(item => [
        item.id,
        item.quantity
      ])
    );

    mount
      .querySelectorAll("[data-product-control]")
      .forEach(control => {
        const productId =
          control.dataset.productControl;

        const quantity =
          quantities.get(productId) ?? 0;

        if (quantity <= 0) {
          control.className =
            "customer-qty-control";

          control.innerHTML = `
            <button
              class="product-add-btn-single"
              data-product-add="${productId}"
              title="Add to order"
              aria-label="Add to order"
            >
              <i class="ph ph-plus"></i>
            </button>
          `;

          return;
        }

        control.className =
          "customer-qty-control is-active";

        control.innerHTML = `
          <button
            class="product-qty-btn"
            data-product-dec="${productId}"
            title="Decrease quantity"
            aria-label="Decrease quantity"
          >
            <i class="ph ph-minus"></i>
          </button>

          <span
            class="product-qty-value"
            aria-live="polite"
          >
            ${quantity}
          </span>

          <button
            class="product-qty-btn"
            data-product-inc="${productId}"
            title="Increase quantity"
            aria-label="Increase quantity"
          >
            <i class="ph ph-plus"></i>
          </button>
        `;
      });
  }

  function animateProductControl(element) {
    const control =
      element.closest(
        "[data-product-control]"
      );

    if (!control) return;

    control.classList.remove(
      "qty-pulse"
    );

    void control.offsetWidth;

    control.classList.add(
      "qty-pulse"
    );
  }

  function renderOrderBar(current) {
    const count = current.items.reduce((sum, item) => sum + item.quantity, 0);
    const node = mount.querySelector("#customer-cart-count");
    const button = mount.querySelector("#customer-review");
    if (!node || !button) return;
    node.textContent = `${count} ${count === 1 ? "item" : "items"}`;
    button.disabled = count === 0;
  }

  function openReview() {
    const current = state.getState();
    if (!current.items.length) return;

    const modal = openAppModal({
      title: "Review your order",
      subtitle: "Confirm this round before it reaches the kitchen.",
      body: reviewBody(current),
      actions: [
        { label: "Keep editing", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Confirm order", icon: "ph-check", className: "btn-primary", onClick: async ({ close, button }) => { button.disabled = true; await submitCustomerOrder(close); } }
      ]
    });

    modal.root.addEventListener("click", event => {
      const inc = event.target.closest("[data-inc]");
      const dec = event.target.closest("[data-dec]");
      if (inc) { state.increment(inc.dataset.inc); refreshReview(modal.root); }
      if (dec) { state.decrement(dec.dataset.dec); refreshReview(modal.root); }
    });
  }

  function reviewBody(current) {
    return `
      <div class="review-note"><i class="ph ph-info"></i><span>This is only this round's review. Your final bill is hidden until you finish the meal.</span></div>
      <div class="review-items">
        ${current.items.map(item => `<div class="review-item"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)} × ${item.quantity}</span></div><div class="review-item-actions"><button class="quantity-btn" data-dec="${item.id}" title="Decrease" aria-label="Decrease"><i class="ph ph-minus"></i></button><strong>${item.quantity}</strong><button class="quantity-btn" data-inc="${item.id}" title="Increase" aria-label="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("")}
      </div>
      <div class="review-footer-note"><i class="ph ph-receipt"></i><span>Everything you order later will stay on the same table session and one final bill.</span></div>`;
  }

  function refreshReview(root) {
    const current = state.getState();
    const body = root.querySelector(".modal-body");
    if (!body) return;
    body.innerHTML = current.items.length ? reviewBody(current) : `<div class="empty-state compact"><i class="ph ph-shopping-bag"></i><strong>Your order is empty.</strong><span>Go back and add something.</span></div>`;
  }

  async function submitCustomerOrder(closeModal) {
    const current = state.getState();
    try {
      const { data, error } = await supabase.rpc("place_customer_order", {
        p_table_id: table.id,
        p_session_token: localStorage.getItem(sessionKey),
        p_items: state.toServerItems(),
        p_note: null,
        p_customer_name: null
      });
      if (error) throw error;
      const result = data?.[0] ?? data;
      if (!result?.order_number) throw new Error("The restaurant did not return an order number.");
      lastOrderNumber = result.order_number;
      state.clear();
      closeModal();
      await showOrderedStage(lastOrderNumber);
    } catch (error) {
      showToast("Could not send your order", error.message, "error");
    }
  }

  async function showOrderedStage(orderNumber = null) {
    const stage = mount.querySelector("#customer-stage");
    const { data, error } = await supabase.rpc("get_customer_session_state", {
      p_table_id: table.id,
      p_session_token: localStorage.getItem(sessionKey)
    });
    if (error) throw error;
    const snapshot = data?.[0] ?? data;
    sessionStatus = snapshot?.status ?? "open";
    lastOrderNumber = orderNumber ?? snapshot?.last_order_number ?? lastOrderNumber;

    stage.innerHTML = `
      <div class="customer-status-shell"><div class="status-card">
        <div class="status-check"><i class="ph ph-check"></i></div>
        <span class="eyebrow">Order received</span>
        <h1>Your order is with the kitchen.</h1>
        <p class="status-lead">You do not need to place another bill. Keep using <strong>Order more</strong> for starters, mains, desserts or anything else during this visit.</p>
        ${lastOrderNumber ? `<div class="order-reference"><span>Latest order</span><strong>#${escapeHtml(lastOrderNumber)}</strong></div>` : ""}
        <div class="session-steps">
          <div class="session-step active"><i class="ph ph-check-circle"></i><div><strong>Order sent</strong><span>Kitchen can see this round.</span></div></div>
          <div class="session-step"><i class="ph ph-shopping-bag"></i><div><strong>Order more</strong><span>Add another course without another bill.</span></div></div>
          <div class="session-step ${sessionStatus === "bill_ready" || sessionStatus === "closed" ? "active" : ""}"><i class="ph ph-receipt"></i><div><strong>Final bill</strong><span>${sessionStatus === "bill_ready" || sessionStatus === "closed" ? "Ready to view." : "Locked until you finish your meal."}</span></div></div>
        </div>
        <div class="status-actions">
          <button class="btn btn-primary btn-large" id="customer-order-more"><i class="ph ph-plus"></i>Order more</button>
          <button class="bill-action ${billClass(sessionStatus)}" id="customer-bill"><i class="ph ${billIcon(sessionStatus)}"></i><span>${billText(sessionStatus)}</span></button>
        </div>
        <div class="bill-helper" id="bill-helper">${billHelper(sessionStatus)}</div>
        <div class="status-order-list" id="status-order-list"></div>
      </div></div>`;

    await refreshStatusSnapshot();
    stage.querySelector("#customer-order-more").addEventListener("click", renderMenu);
    stage.querySelector("#customer-bill").addEventListener("click", handleBillAction);
    startPolling();
  }

  async function refreshStatusSnapshot() {
    const { data, error } = await supabase.rpc("get_customer_session_state", {
      p_table_id: table.id,
      p_session_token: localStorage.getItem(sessionKey)
    });
    if (error) return;
    const snapshot = data?.[0] ?? data;
    if (!snapshot) return;
    sessionStatus = snapshot.status;
    lastOrderNumber = snapshot.last_order_number ?? lastOrderNumber;

    const helper = mount.querySelector("#bill-helper");
    const bill = mount.querySelector("#customer-bill");
    if (helper) helper.innerHTML = billHelper(sessionStatus);
    if (bill) {
      bill.className = `bill-action ${billClass(sessionStatus)}`;
      bill.innerHTML = `<i class="ph ${billIcon(sessionStatus)}"></i><span>${billText(sessionStatus)}</span>`;
    }

    const list = mount.querySelector("#status-order-list");
    if (list) {
      const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
      list.innerHTML = orders.length ? `<div class="mini-section-label">Recent rounds</div>${orders.slice().reverse().map(order => `<div class="mini-order-row"><div class="mini-order-icon"><i class="ph ph-check"></i></div><div><strong>Order #${escapeHtml(order.order_number)}</strong><span>${Number(order.item_count || 0)} ${Number(order.item_count || 0) === 1 ? "item" : "items"}</span></div><small>${formatTime(order.created_at)}</small></div>`).join("")}` : "";
    }
  }

  async function handleBillAction() {
    if (sessionStatus === "bill_ready" || sessionStatus === "closed") return showFinalBill();
    if (sessionStatus === "bill_requested") return showToast("Bill requested", "The restaurant is preparing your final bill.");

    openAppModal({
      title: "Finish your meal?",
      subtitle: "Request the final bill for this table.",
      body: `<div class="finish-meal-panel"><div class="finish-meal-icon"><i class="ph ph-receipt"></i></div><h3>Ready for your final bill?</h3><p>You can still choose Order more instead. Continue only when the table is finished with the meal.</p><div class="finish-meal-rule"><i class="ph ph-check-circle"></i><span>Your previous and future rounds stay together as one bill.</span></div></div>`,
      actions: [
        { label: "Not yet", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Request bill", icon: "ph-receipt", className: "btn-primary", onClick: async ({ close, button }) => {
          button.disabled = true;
          try {
            const { data, error } = await supabase.rpc("request_session_bill", { p_table_id: table.id, p_session_token: localStorage.getItem(sessionKey) });
            if (error) throw error;
            sessionStatus = data?.[0]?.status ?? "bill_requested";
            close();
            await refreshStatusSnapshot();
            showToast("Bill requested", "The restaurant is preparing your final bill.");
          } catch (error) { button.disabled = false; showToast("Could not request bill", error.message, "error"); }
        }}
      ]
    });
  }

  async function showFinalBill() {
    const { data, error } = await supabase.rpc("get_customer_session_bill", {
      p_table_id: table.id,
      p_session_token: localStorage.getItem(sessionKey)
    });
    if (error) return showToast("Bill is not ready", error.message, "error");
    const bill = data?.[0] ?? data;
    const orders = Array.isArray(bill.orders) ? bill.orders : [];
    const stage = mount.querySelector("#customer-stage");

    stage.innerHTML = `
      <div class="customer-bill-shell">
        <div class="bill-paper">
          <div class="bill-paper-head"><div class="bill-paper-brand"><img src="${versionedAsset("assets/images/website_icon.png")}" alt=""><div><strong>Four Flavours</strong><span>Table ${escapeHtml(table.table_no)}</span></div></div><span class="bill-ready-badge"><i class="ph ph-check-circle"></i>Final bill</span></div>
          <div class="bill-divider"></div>
          <div class="bill-rounds">
            ${orders.map((round, index) => `<section class="bill-round"><div class="bill-round-head"><div><span>Round ${index + 1}</span><strong>#${escapeHtml(round.order_number)}</strong></div><small>${formatDateTime(round.created_at)}</small></div>${(round.items ?? []).map(item => `<div class="bill-line"><div><strong>${escapeHtml(item.name)}</strong><span>${item.quantity} × ${money(item.unit_price)}</span></div><strong>${money(item.line_total)}</strong></div>`).join("")}</section>`).join("")}
          </div>
          <div class="bill-divider"></div>
          <div class="bill-summary"><div><span>Subtotal</span><strong>${money(bill.subtotal)}</strong></div><div><span>CGST (${Number(bill.cgst_rate).toFixed(2)}%)</span><strong>${money(bill.cgst)}</strong></div><div><span>SGST (${Number(bill.sgst_rate).toFixed(2)}%)</span><strong>${money(bill.sgst)}</strong></div><div><span>Rounding</span><strong>${money(bill.rounding)}</strong></div><div class="bill-grand"><span>Total</span><strong>${money(bill.grand_total)}</strong></div></div>
          <div class="bill-paper-foot"><i class="ph ph-sparkle"></i><span>Thank you for dining with Four Flavours.</span></div>
        </div>
        <div class="bill-actions">${sessionStatus === "closed" ? `<button class="btn btn-quiet btn-large" disabled><i class="ph ph-lock"></i>Dining session closed</button>` : `<button class="btn btn-primary btn-large" id="customer-order-more-from-bill"><i class="ph ph-plus"></i>Order more</button>`}<button class="btn btn-quiet btn-large" id="customer-back-status"><i class="ph ph-arrow-left"></i>Back</button></div>
        <div class="bill-after-note">${sessionStatus === "closed" ? "This table session has been settled. Thank you for dining with Four Flavours." : "Ordering more will reopen the dining session and update the final bill when you finish again."}</div>
      </div>`;

    stage.querySelector("#customer-order-more-from-bill")?.addEventListener("click", renderMenu);
    stage.querySelector("#customer-back-status").addEventListener("click", () => showOrderedStage());
    stopPolling();
  }

  function startPolling() { stopPolling(); pollingTimer = setInterval(refreshStatusSnapshot, 4500); }
  function stopPolling() { if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; } }
  const billClass = status => status === "bill_ready" || status === "closed" ? "ready" : status === "bill_requested" ? "waiting" : "locked";
  const billIcon = status => status === "bill_ready" || status === "closed" ? "ph-receipt" : status === "bill_requested" ? "ph-clock" : "ph-lock-key";
  const billText = status => status === "bill_ready" || status === "closed" ? "View bill" : status === "bill_requested" ? "Bill requested" : "Bill";
  const billHelper = status => status === "bill_ready" || status === "closed" ? `<i class="ph ph-check-circle"></i>The restaurant has marked your meal complete and the final bill is ready.` : status === "bill_requested" ? `<i class="ph ph-clock"></i>Waiting for the restaurant to prepare the final bill.` : `<i class="ph ph-lock-key"></i>Bill stays locked until you choose to finish your meal.`;
  const formatTime = value => { try { return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(value)); } catch { return ""; } };
  const formatDateTime = value => { try { return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value)); } catch { return ""; } };

  renderMenu();

  return () => { stopPolling(); try { lenis?.destroy?.(); } catch {} };
}
