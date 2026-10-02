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
  
  window.__FOUR_FLAVOURS_POS_STATE__ = state; // Exposes state for Admin Routing
  
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
    <section class="pos-page">
      <header class="app-topbar pos-topbar">
        <div class="topbar-side topbar-left" style="gap: 12px;">
          <button class="icon-btn icon-btn-dark" id="pos-menu" title="Open menu" aria-label="Open menu"><i class="ph ph-list"></i></button>
          <img src="${versionedAsset("assets/images/website_logo.png")}" alt="Four Flavours" style="height: 28px; width: auto;" />
        </div>
        <div class="brand-center pos-brand-center main-logo-only">
          <!-- Center logo moved to top-left -->
        </div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="pos-search-toggle" title="Search"><i class="ph ph-magnifying-glass"></i></button>
          <button class="icon-btn icon-btn-dark icon-badge-btn" id="pos-orders" title="Table orders" aria-label="Table orders"><i class="ph ph-bell"></i><span class="icon-badge hidden" id="pos-order-badge">0</span></button>
        </div>
      </header>
      
      <div class="pos-search-backdrop" id="pos-search-backdrop">
        <div class="pos-search-panel">
          <div class="search-bar-row">
            <div class="search-input-wrap">
              <i class="ph-bold ph-magnifying-glass"></i>
              <input id="pos-search" class="search-input" type="text" placeholder="Search dishes..." autocomplete="off">
              <button id="pos-search-clear" class="icon-btn is-hidden"><i class="ph-bold ph-x"></i></button>
            </div>
            <button id="pos-search-cancel" class="btn-quiet">Cancel</button>
          </div>
          <div class="search-suggestions" id="search-suggestions"></div>
        </div>
      </div>

      <main class="pos-content">
        <section class="pos-toolbar-row">
          <button class="pos-toolbar-pill active" data-order-type="dine_in"><i class="ph-bold ph-armchair"></i><span>Dine-in</span></button>
          <button class="pos-toolbar-pill" data-order-type="takeaway"><i class="ph-bold ph-shopping-bag"></i><span>Takeaway</span></button>
          <div class="pos-toolbar-pill" id="pos-table-wrap" style="cursor: pointer;" title="Select Table">
            <span class="selected-text" id="pos-table-display"><i class="ph-bold ph-armchair"></i><span>Table</span><i class="ph ph-caret-down"></i></span>
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
  
  const searchBackdrop = mount.querySelector("#pos-search-backdrop");
  const searchInput = mount.querySelector("#pos-search");
  const searchClear = mount.querySelector("#pos-search-clear");
  const searchSuggestions = mount.querySelector("#search-suggestions");
  
  // Load recents from device storage
  let recentSearches = JSON.parse(localStorage.getItem("fourflavours_recent_searches") || "[]");

  mount.querySelector("#pos-search-toggle").addEventListener("click", () => {
    searchBackdrop.classList.add("active");
    searchInput.focus();
    renderSearchSuggestions();
  });

  mount.querySelector("#pos-search-cancel").addEventListener("click", () => {
    searchBackdrop.classList.remove("active");
    searchInput.value = "";
    searchClear.classList.add("is-hidden");
    searchTerm = "";
    renderProducts();
  });

  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchInput.focus();
    searchClear.classList.add("is-hidden");
    renderSearchSuggestions();
  });

  searchInput.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    searchClear.classList.toggle("is-hidden", val === "");
    renderSearchSuggestions(val);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && searchInput.value.trim()) {
      executeSearch(searchInput.value.trim());
    }
  });

  function executeSearch(query) {
    if (!query) return;
    // Save to recents (max 5)
    recentSearches = [query, ...recentSearches.filter(s => s.toLowerCase() !== query.toLowerCase())].slice(0, 5);
    localStorage.setItem("fourflavours_recent_searches", JSON.stringify(recentSearches));
    
    searchTerm = query.toLowerCase();
    searchBackdrop.classList.remove("active");
    renderProducts();
  }

  function renderSearchSuggestions(query = "") {
    let html = "";
    
    if (query) {
      // Live Filtering Results
      const hits = products.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
      if (hits.length) {
        html += `<div class="search-group-title">Matches</div><div class="search-list">`;
        html += hits.map(p => `<button class="search-list-item" data-search-trigger="${escapeHtml(p.name)}"><i class="ph ph-magnifying-glass"></i><span>${escapeHtml(p.name)}</span></button>`).join("");
        html += `</div>`;
      } else {
        html = `<div class="empty-state compact"><i class="ph ph-magnifying-glass"></i><strong>No exact matches</strong><span>Press enter to search anyway.</span></div>`;
      }
    } else {
      // 1. Show Recents
      if (recentSearches.length > 0) {
        html += `<div class="search-group-title">Recent Searches</div><div class="search-tags">`;
        html += recentSearches.map(s => `<button class="search-tag" data-search-trigger="${escapeHtml(s)}"><i class="ph ph-clock-counter-clockwise"></i>${escapeHtml(s)}</button>`).join("");
        html += `</div>`;
      }

      // 2. Show Dynamic Recommendations (Randomized per load for variety)
      const shuffled = [...products].sort(() => 0.5 - Math.random()).slice(0, 4);
      if (shuffled.length > 0) {
        html += `<div class="search-group-title">Perfect Meals Recommended For You</div><div class="search-list">`;
        html += shuffled.map(p => `<button class="search-list-item" data-search-trigger="${escapeHtml(p.name)}"><i class="ph ph-star"></i><span>${escapeHtml(p.name)}</span><small>${money(p.price, settings.currency_symbol)}</small></button>`).join("");
        html += `</div>`;
      }
    }

    searchSuggestions.innerHTML = html;
    searchSuggestions.querySelectorAll("[data-search-trigger]").forEach(btn => {
      btn.addEventListener("click", () => {
        searchInput.value = btn.dataset.searchTrigger;
        executeSearch(btn.dataset.searchTrigger);
      });
    });
  }
  
  const tableDisplay = mount.querySelector("#pos-table-display span");
  const tableWrapBtn = mount.querySelector("#pos-table-wrap");
  let autoOpenReview = false;

  tableWrapBtn.addEventListener("click", (e) => {
    if (state.getState().orderType === "takeaway") return;
    
    // Detect if this click came programmatically from the "Next" button smart redirect
    autoOpenReview = e.isTrusted === false || window._autoReviewPending;
    window._autoReviewPending = false;
    
    const modal = openAppModal({
      title: "Select Table",
      subtitle: "Assign a table for this dine-in session.",
      body: `<div class="table-selection-list" style="max-height: 50vh; overflow-y: auto; margin: -10px -24px;">
        ${tables.length ? tables.map(t => `
          <button class="btn btn-quiet table-select-btn" data-table-id="${t.id}" style="width: 100%; border-radius: 0; justify-content: flex-start; padding: 18px 24px; font-size: 16px; border-bottom: 1px solid var(--line);">
            <i class="ph-bold ph-armchair" style="color: var(--forest-600); margin-right: 14px; font-size: 20px;"></i>
            <strong style="color: var(--forest-950);">Table ${escapeHtml(t.table_no)}</strong>
            <span style="margin-left: auto; font-size: 13px; font-weight: 700; color: var(--muted);">${t.capacity} seats</span>
          </button>
        `).join("") : `<div class="empty-state"><i class="ph-bold ph-armchair"></i><strong>No active tables</strong></div>`}
      </div>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: (ctx) => { autoOpenReview = false; ctx.close(); } }
      ]
    });

    modal.root.querySelectorAll(".table-select-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const table = tables.find(t => t.id === btn.dataset.tableId) ?? null;
        state.setTable(table);
        tableDisplay.textContent = table ? `Table ${table.table_no}` : "Table";
        modal.close();
        
        // Smart Redirect: If triggered by 'Next' and cart has items, seamlessly transition to Review
        if (autoOpenReview && state.getState().items.length > 0) {
          autoOpenReview = false;
          openReview();
        }
      });
    });
  });
  
  mount.querySelectorAll("[data-order-type]").forEach(button => button.addEventListener("click", () => { 
    state.setOrderType(button.dataset.orderType); 
    mount.querySelectorAll("[data-order-type]").forEach(el => el.classList.toggle("active", el === button)); 
    tableWrapBtn.classList.toggle("is-disabled", button.dataset.orderType === "takeaway"); 
    if (button.dataset.orderType === "takeaway") {
      state.setTable(null);
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
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: calc(100vh - 180px); padding-bottom: 20px;">
          <div class="drill-down-header" style="text-align: center; margin-bottom: 24px; width: 100%;">
            <h2 style="font-size: 22px;">Choose a Cuisine</h2>
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
          // 1. Add the tactile animation class immediately
          card.classList.add("pressed");
          
          // 2. Wait exactly 150ms for the physical "press" animation to visually complete
          setTimeout(() => {
            activeCuisine = card.dataset.cuisine;
            activeSubCategory = "All";
            searchTerm = "";
            const searchInput = mount.querySelector("#pos-search");
            if (searchInput) searchInput.value = "";
            
            // Push navigation state so the physical back button works
            window.history.pushState({ view: "cuisine", cuisine: activeCuisine }, "", "#" + encodeURIComponent(activeCuisine));
            renderProducts();
          }, 150);
        });
      });
      return;
    }

    const subCategories = getAvailableSubCategories();
    
    let html = ``;
    if (!searchTerm) {
      html += `
        <div class="drill-down-header floating-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="icon-btn icon-btn-light" id="pos-btn-back" title="Back"><i class="ph ph-arrow-left"></i></button>
            <h2 style="margin: 0;">${escapeHtml(activeCuisine)}</h2>
          </div>
          <div class="header-right-actions">
            <button class="cat-toggle-btn" id="pos-cat-toggle">
              <span>${escapeHtml(activeSubCategory)}</span>
              <i class="ph ph-caret-down"></i>
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
      html += `<div class="drill-down-header floating-header"><h2>Search results for "${escapeHtml(searchTerm)}"</h2></div>`;
    }

    html += `<section class="pos-product-container" id="pos-product-container" style="padding-top: 70px;"><div class="pos-product-grid" id="pos-product-grid"></div></section>`;
    
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

      if (add) { const product = products.find(item => item.id === add.dataset.productAdd); if (!product) return; state.addProduct(product); animateProductControl(add); return; }
      if (inc) { state.increment(inc.dataset.productInc); animateProductControl(inc); return; }
      if (dec) { state.decrement(dec.dataset.productDec); animateProductControl(dec); }
    });

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
    mount.querySelector("#pos-cart-total").textContent = count > 0 ? `Total: ${money(total, settings.currency_symbol)}` : "Tap Next to review";
    
    mount.querySelector("#pos-next").disabled = false;

    const actionBar = mount.querySelector(".pos-action-bar");
    if (actionBar) {
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
      // Smart Redirect: If it's dine-in and no table is selected, instantly pop open the table modal!
      if (current.orderType === "dine_in" && !current.tableId) {
        window._autoReviewPending = true; // Leaves a secure flag for the Table Modal to catch
        mount.querySelector("#pos-table-wrap").click();
        return;
      }
      // Otherwise, it means their cart is empty
      showToast("Complete the order", "Add at least one dish.", "error"); 
      return; 
    }
    
    const sessionKey = current.orderType === "dine_in" ? current.tableId : "takeaway_session";
    const isOpen = !!activeTableOrders[sessionKey];

    const modal = openAppModal({
      title: "Review order",
      subtitle: "Review your items before sending to the kitchen.",
      body: `<div class="pos-review-head"><div><span class="eyebrow">Order</span><strong>${current.orderType === "dine_in" ? `Dine-in · Table ${escapeHtml(tables.find(t => t.id === current.tableId)?.table_no ?? "")}` : "Takeaway"}</strong></div><span class="secure-mini"><i class="ph ph-shield-check"></i>Verified</span></div><div class="review-items">${current.items.map(item => `<div class="review-item"><div class="review-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)} ×${item.quantity}</span></div><div class="review-item-actions"><button class="quantity-btn" data-dec="${item.id}" title="Decrease" aria-label="Decrease"><i class="ph ph-minus"></i></button><strong>${item.quantity}</strong><button class="quantity-btn" data-inc="${item.id}" title="Increase" aria-label="Increase"><i class="ph ph-plus"></i></button></div></div>`).join("")}</div><div class="review-total-hint"><i class="ph ph-info"></i><span>GST and the final total are calculated securely by the server.</span></div>`,
      actions: [
        { label: "Keep editing", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: isOpen ? "Update Kitchen" : "Confirm order", icon: "ph-check", className: "btn-primary", onClick: async ({ close, button }) => { button.disabled = true; await submitPOSOrder(close); } }
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
    const sessionKey = current.orderType === "dine_in" ? current.tableId : "takeaway_session";
    const openOrderId = activeTableOrders[sessionKey];

    try {
      let result;
      
      if (openOrderId) {
        // SYNC local cart exactly with the database overwriting with new state
        const { data, error } = await supabase.rpc("sync_pos_order", { p_order_id: openOrderId, p_items: state.toServerItems() });
        if (error) throw error;
        result = data;
        showToast("Kitchen Updated", `Order #${result.order_number} has been updated.`);
      } else {
        // CREATE a brand new bill
        const { data, error } = await supabase.rpc("create_pos_order", { p_order_type: current.orderType, p_table_id: current.tableId, p_items: state.toServerItems(), p_note: null });
        if (error) throw error;
        result = data?.[0] ?? data;
        if (!result?.order_number) throw new Error("The restaurant did not return an order number.");
        showToast("Order sent to kitchen", `Order #${result.order_number} is being prepared.`);
      }

      // 💡 DO NOT clear the cart! The local cart stays perfectly intact until checkout.
      activeTableOrders[sessionKey] = result.id;
      closeModal(); 
      
      // Send them to the Checkout Dashboard
      showActiveOrderDashboard({ order: result, settings, current_state: current, sessionKey });
    } catch (error) { showToast("Order failed", error.message, "error"); }
  }

  function showActiveOrderDashboard({ order, settings, current_state, sessionKey }) {
    const t = tables.find(x => x.id === current_state.tableId);
    const titleStr = current_state.orderType === "dine_in" ? `Table ${t ? t.table_no : "Unknown"} · Active Order` : `Takeaway · Active Order`;
    let activeOrder = order;

    const modal = openAppModal({
      title: titleStr,
      subtitle: "Your order is open. Add more items or complete your bill.",
      body: `<div id="active-dash-host"></div>`,
      actions: [
        { label: "Keep Ordering", icon: "ph-plus-circle", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Complete Order", icon: "ph-check-circle", className: "btn-primary", onClick: ({ close }) => {
            openAppModal({
              title: "Generate Final Bill?",
              subtitle: "Confirm you are finished with this order.",
              body: `<div class="danger-confirm"><div class="danger-confirm-icon" style="background: var(--sage-200); color: var(--forest-900);"><i class="ph-bold ph-receipt"></i></div><h3>Generate Final Bill?</h3><p>This will generate the PDF receipt. You cannot add more items after this.</p></div>`,
              actions: [
                { label: "No, Go Back", className: "btn-quiet", onClick: (ctx) => ctx.close() },
                { label: "Yes, I'm Done", className: "btn-primary", onClick: async (ctx) => {
                    ctx.close(); close(); 
                    showReceiptPreview({ order: activeOrder, items: state.getState().items, settings, current_state }); 
                    state.clear();
                    delete activeTableOrders[sessionKey];
                }}
              ]
            });
          }
        }
      ]
    });

    function renderDash() {
      const host = modal.root.querySelector("#active-dash-host");
      if (!host) return;

      host.innerHTML = `
        <div class="active-dining-dashboard">
          <div class="dining-status-banner">
            <i class="ph-bold ph-cooking-pot"></i>
            <div>
              <strong>Order #${activeOrder.order_number} is open</strong>
              <span id="dash-live-total">Live Total: ${money(activeOrder.grand_total, settings.currency_symbol)}</span>
            </div>
          </div>
          <h3 class="dining-section-title">Current Order Items</h3>
          <div class="dining-items-list" style="max-height: 40vh; overflow-y: auto;">
            ${state.getState().items.map(i => `
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
          // 1. Animate the button click for visual feedback
          btn.classList.remove("qty-pulse");
          void btn.offsetWidth;
          btn.classList.add("qty-pulse");

          // 2. Increment in local cart instantly
          const id = btn.dataset.id;
          state.increment(id);
          
          // 3. Update the UI quantity badge instantly without full re-render
          const updatedItem = state.getState().items.find(x => x.id === id);
          const badge = host.querySelector(`#dash-qty-${id}`);
          if (badge && updatedItem) badge.innerText = `x${updatedItem.quantity}`;

          // 4. Sync quietly in the background to update the kitchen and total
          try {
            btn.disabled = true;
            const { data, error } = await supabase.rpc("sync_pos_order", { p_order_id: activeOrder.id, p_items: state.toServerItems() });
            if (!error && data) {
              activeOrder = data;
              const totalEl = host.querySelector("#dash-live-total");
              if (totalEl) totalEl.innerText = `Live Total: ${money(activeOrder.grand_total, settings.currency_symbol)}`;
            }
          } catch(e) { console.error("Sync failed:", e); } 
          finally { btn.disabled = false; }
        });
      });
    }

    renderDash();
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
      // 50ms delay ensures the DOM is fully painted before drawing the QR Canvas
      setTimeout(() => {
        const qr = modal.root.querySelector("#thermal-upi");
        if (qr) {
          qr.innerHTML = ""; // Clears any old artifacts
          
          // Strictly encode the parameters to ensure 100% compatibility with all UPI apps
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
      if (qr) {
        qr.innerHTML = "";
        
        const pa = encodeURIComponent(settings.upi_id.trim());
        const pn = encodeURIComponent(settings.restaurant_name.trim());
        const am = Number(order.grand_total).toFixed(2);
        const tn = encodeURIComponent(`Order #${order.order_number}`);
        const upiString = `upi://pay?pa=${pa}&pn=${pn}&am=${am}&cu=INR&tn=${tn}`;
        
        new QRCode(qr, { text: upiString, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
        
        // 100ms pause guarantees the browser finishes generating the canvas before the print dialog locks the thread
        await new Promise(r => setTimeout(r, 100)); 
      }
    }
    window.print();
  }

  return async () => { 
    window.removeEventListener("popstate", handlePopState);
    document.removeEventListener("click", handleOutsideClick); 
    drawerCleanup?.(); 
    if (realtimeChannel) { try { await supabase.removeChannel(realtimeChannel); } catch {} } 
  };
}