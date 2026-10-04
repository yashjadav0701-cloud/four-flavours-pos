import { versionedAsset } from "../core/config.js";
import { supabase, signOut } from "../core/supabase.js";

window.__unreadAdminCount = window.__unreadAdminCount || 0;
window.__adminAlerts = window.__adminAlerts || [];
window.__orderTotalsCache = window.__orderTotalsCache || new Map();
window.__sessionStatusCache = window.__sessionStatusCache || new Map();

export function updateGlobalNotificationBadge() {
  const drawerDot = document.getElementById("admin-drawer-dot");
  const hamburgerDots = document.querySelectorAll(".hamburger-dot");
  const show = window.__unreadAdminCount > 0;
  
  if (drawerDot) drawerDot.style.display = show ? "block" : "none";
  hamburgerDots.forEach(dot => { dot.style.display = show ? "block" : "none"; });
}
// Attach to the global window so the Admin dashboard can securely trigger it
window.updateGlobalNotificationBadge = updateGlobalNotificationBadge;

export function clearGlobalNotification() {
  window.__unreadAdminCount = 0;
  window.__adminAlerts = [];
  updateGlobalNotificationBadge();
}
window.clearGlobalNotification = clearGlobalNotification;

export function addAdminAlert(title, message, tableId = null) {
  window.__adminAlerts.unshift({ title, message, tableId });
  if (window.__adminAlerts.length > 15) window.__adminAlerts.pop(); 
  window.__unreadAdminCount++;
  updateGlobalNotificationBadge();
  window.dispatchEvent(new Event("ff_admin_alert_received"));
}

// Ensure the listener only boots up on staff devices, NOT customer phones!
const isCustomerMode = Boolean(new URLSearchParams(window.location.search).get("table") || new URLSearchParams(window.location.search).get("t"));

if (!isCustomerMode && !window.__FF_GLOBAL_LISTENER__) {
  window.__FF_GLOBAL_LISTENER__ = true;
  
  function getTableNo(tableId) {
    if (!tableId) return "Takeaway";
    if (window.__FF_TABLES__) {
       const t = window.__FF_TABLES__.find(x => x.id === tableId);
       if (t) return t.table_no;
    }
    return "Unknown";
  }

  // INTELLIGENT BROADCAST LISTENER: Completely bypasses PostgreSQL triggers.
  // We listen directly to explicit events sent by the customer's browser.
  supabase.channel('ff-admin-alerts')
    .on('broadcast', { event: 'customer_order' }, payload => {
       const tableNo = getTableNo(payload.payload.tableId);
       if (payload.payload.isNew) {
          addAdminAlert("New Customer Order", `Table ${tableNo} sent a new order to the kitchen.`, payload.payload.tableId);
       } else {
          addAdminAlert("Customer Added Items", `Table ${tableNo} added more items to their live tab.`, payload.payload.tableId);
       }
    })
    .on('broadcast', { event: 'customer_bill' }, payload => {
       const tableNo = getTableNo(payload.payload.tableId);
       addAdminAlert("Bill Requested", `Table ${tableNo} requested their final bill.`, payload.payload.tableId);
    })
    .subscribe();
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function money(value, symbol = "₹") { return `${symbol}${Number(value || 0).toFixed(2)}`; }

export function showToast(title, message, type = "success") {
  // STRICT OVERRIDE: Suppress all "success" popups across the entire app
  if (type === "success") return;

  const root = document.getElementById("toast-root");
  if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon"><i class="ph ${type === "error" ? "ph-warning-circle" : "ph-check-circle"}"></i></div><div class="toast-copy"><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ""}</div>`;
  root.appendChild(toast);
  window.setTimeout(() => { toast.classList.add("leaving"); window.setTimeout(() => toast.remove(), 180); }, 3400);
}

export function mountNavigation({ active = "pos" }) {
  const root = document.createElement("div");
  
  // Dynamic Contextual Configuration
  const isPos = active === "pos";
  const actionIcon = isPos ? "ph-sign-out" : "ph-lock-key";
  const actionText = isPos ? "Sign Out" : "Lock & Return to POS";
  const actionColor = isPos ? "var(--danger)" : "var(--forest-900)";
  const actionId = isPos ? "staff-sign-out" : "admin-lock-workspace";

  root.innerHTML = `
    <div class="drawer-overlay" data-drawer-overlay></div>
    <aside class="app-drawer" data-app-drawer aria-label="Application navigation">
      <div class="drawer-head">
        <img src="${versionedAsset("assets/images/website_icon.svg")}" alt="" />
        <div><strong>Four Flavours</strong><small>Restaurant OS</small></div>
        <button class="icon-btn icon-btn-dark" data-close-drawer title="Close menu" aria-label="Close menu"><i class="ph ph-x"></i></button>
      </div>
      <nav class="drawer-nav">
        <button class="drawer-nav-item ${isPos ? "active" : ""}" data-route="/"><i class="ph-bold ph-storefront"></i><span>POS</span></button>
        <button class="drawer-nav-item ${active === "admin" ? "active" : ""}" data-route="#/4">
          <i class="ph-bold ph-shield-check"></i><span>Admin</span>
          <span id="admin-drawer-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #e11d48; margin-left: auto; display: none;"></span>
        </button>
      </nav>
      <div class="drawer-foot" style="margin-top: auto; padding-bottom: 24px;">
         <button class="btn btn-quiet" id="${actionId}" style="width: 100%; border-color: var(--line); color: ${actionColor}; font-weight: 800;"><i class="ph-bold ${actionIcon}"></i> ${actionText}</button>
      </div>
    </aside>`;
  document.body.appendChild(root);

  const drawer = root.querySelector("[data-app-drawer]");
  const overlay = root.querySelector("[data-drawer-overlay]");
  const setOpen = open => { drawer.classList.toggle("open", open); overlay.classList.toggle("open", open); document.body.classList.toggle("drawer-open", open); };

  // Secure Contextual Button Logic
  root.querySelector(`#${actionId}`)?.addEventListener("click", async () => {
      setOpen(false); // Instantly close the drawer for a snappy feel
      
      if (isPos) {
          // POS MODE: Hard Sign-Out
          try {
             sessionStorage.removeItem("ff_staff_active");
             await signOut(); 
             window.location.reload(); 
          } catch (err) {
             console.error("Sign out failed:", err);
          }
      } else {
          // ADMIN MODE: Lock Workspace & Return to POS floor
          history.pushState({}, "", location.pathname);
          location.hash = "";
          window.dispatchEvent(new Event("fourflavours:navigate"));
      }
  });

  root.addEventListener("click", async event => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      setOpen(false);
      const target = routeButton.dataset.route;
      
      // NOTE: Auto-clear removed! The red dot will stay until the staff actively clears the Inbox.
      
      if (target === "/") { history.pushState({}, "", location.pathname); location.hash = ""; }
      else location.hash = target;
      window.dispatchEvent(new Event("fourflavours:navigate"));
      return;
    }
    if (event.target.closest("[data-close-drawer]") || event.target.closest("[data-drawer-overlay]")) { setOpen(false); return; }
  });

  window.__FOUR_FLAVOURS_NAV__ = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!drawer.classList.contains("open")) };
  
  // Sync dot visibility instantly when the drawer mounts
  setTimeout(updateGlobalNotificationBadge, 50);
  
  return () => { setOpen(false); root.remove(); delete window.__FOUR_FLAVOURS_NAV__; };
}

export function openAppModal({ title, subtitle = "", body, actions = [] }) {
  const root = document.createElement("div");
  root.className = "modal-backdrop";
  root.innerHTML = `
    <section class="app-modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <div class="modal-title-wrap">
          <span class="modal-kicker"><i class="ph ph-sparkle"></i>Four Flavours</span>
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
        </div>
        <button class="icon-btn icon-btn-light" data-modal-close title="Close" aria-label="Close"><i class="ph ph-x"></i></button>
      </header>
      <div class="modal-body">${body}</div>
      ${actions.length ? `<footer class="modal-actions">${actions.map((a,i)=>`<button class="btn ${a.className ?? "btn-quiet"}" data-modal-action="${i}" ${a.disabled ? "disabled" : ""}>${a.icon ? `<i class="ph ${a.icon}"></i>` : ""}${escapeHtml(a.label)}</button>`).join("")}</footer>` : ""}
    </section>`;
  document.body.appendChild(root);
  document.body.classList.add("modal-open");
  const close = () => { root.remove(); document.body.classList.remove("modal-open"); document.removeEventListener("keydown", esc); };
  root.querySelector("[data-modal-close]")?.addEventListener("click", close);
  root.addEventListener("click", event => {
    if (event.target === root) close();
    const action = event.target.closest("[data-modal-action]");
    if (!action) return;
    const index = Number(action.dataset.modalAction);
    actions[index]?.onClick?.({ root, close, button: action });
  });
  const esc = event => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", esc);
  return { root, close };
}
