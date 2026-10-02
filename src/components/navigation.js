import { versionedAsset } from "../core/config.js";
import { signOut } from "../core/supabase.js";

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function money(value, symbol = "₹") { return `${symbol}${Number(value || 0).toFixed(2)}`; }

export function showToast(title, message = "", type = "success") {
  const root = document.querySelector("#toast-root"); if (!root) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon"><i class="ph ${type === "error" ? "ph-warning-circle" : "ph-check-circle"}"></i></div><div class="toast-copy"><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ""}</div>`;
  root.appendChild(toast);
  window.setTimeout(() => { toast.classList.add("leaving"); window.setTimeout(() => toast.remove(), 180); }, 3400);
}

export function mountNavigation({ active = "pos" }) {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="drawer-overlay" data-drawer-overlay></div>
    <aside class="app-drawer" data-app-drawer aria-label="Application navigation">
      <div class="drawer-head">
        <img src="${versionedAsset("assets/images/website_icon.png")}" alt="" />
        <div><strong>Four Flavours</strong><small>Restaurant OS</small></div>
        <button class="icon-btn icon-btn-dark" data-close-drawer title="Close menu" aria-label="Close menu"><i class="ph ph-x"></i></button>
      </div>
      <nav class="drawer-nav">
        <button class="drawer-nav-item ${active === "pos" ? "active" : ""}" data-route="/"><i class="ph ph-storefront"></i><span>POS</span></button>
        <button class="drawer-nav-item ${active === "admin" ? "active" : ""}" data-route="#/4"><i class="ph ph-shield-check"></i><span>Admin</span></button>
      </nav>
    </aside>`;
  document.body.appendChild(root);

  const drawer = root.querySelector("[data-app-drawer]");
  const overlay = root.querySelector("[data-drawer-overlay]");
  const setOpen = open => { drawer.classList.toggle("open", open); overlay.classList.toggle("open", open); document.body.classList.toggle("drawer-open", open); };

  root.addEventListener("click", async event => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      setOpen(false);
      const target = routeButton.dataset.route;
      if (target === "/") { history.pushState({}, "", location.pathname); location.hash = ""; }
      else location.hash = target;
      window.dispatchEvent(new Event("fourflavours:navigate"));
      return;
    }
    if (event.target.closest("[data-close-drawer]") || event.target.closest("[data-drawer-overlay]")) { setOpen(false); return; }
  });

  window.__FOUR_FLAVOURS_NAV__ = { open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!drawer.classList.contains("open")) };
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
