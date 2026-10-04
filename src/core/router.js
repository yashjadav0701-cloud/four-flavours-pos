let activeCleanup = null;
let started = false;

function getRoute() {
  const params = new URLSearchParams(location.search);
  const tableId = params.get("table");
  if (tableId) return { name: "customer", tableId, key: `customer:${tableId}` };
  if (location.hash === "#/4") return { name: "admin", key: "admin" };
  return { name: "pos", key: "pos" };
}

async function moduleFor(name) {
  if (name === "customer") return import("../customer/index.js");
  if (name === "admin") return import("../admin/index.js");
  return import("../pos/index.js");
}

export async function renderRoute(mount) {
  const route = getRoute();
  if (activeCleanup) {
    try { await activeCleanup(); } catch (error) { console.warn("View cleanup failed", error); }
    activeCleanup = null;
  }

  mount.innerHTML = `<section class="loading-screen"><div class="loading-mark"><span></span><span></span><span></span></div></section>`;

  // TIER 1 SECURITY: Block POS and Admin from unauthorized access
  if (route.name !== "customer") {
    const { getSession } = await import("./supabase.js");
    const session = await getSession();
    
    // Check if there is a session AND it is actively verified for this specific browser tab session
    const isSessionVerified = session && sessionStorage.getItem("ff_staff_active") === "true";
    
    if (!isSessionVerified) {
       const { renderStaffLogin } = await import("../components/lockScreen.js");
       const cleanup = await renderStaffLogin({
           mount,
           onLogin: () => {
               // Mark this browser tab as securely authenticated
               sessionStorage.setItem("ff_staff_active", "true");
               window.dispatchEvent(new Event("fourflavours:navigate"));
           }
       });
       activeCleanup = typeof cleanup === "function" ? cleanup : null;
       return route;
    }
  }

  const view = await moduleFor(route.name);
  if (typeof view.render !== "function") throw new Error(`View ${route.name} must export render().`);
  const cleanup = await view.render({ mount, route });
  activeCleanup = typeof cleanup === "function" ? cleanup : null;
  return route;
}

export function startRouter({ mount }) {
  if (started) return;
  started = true;

  // STRICT SECURITY: Force sign-out on fresh launch (new tab/window) to ensure staff always log in
  const isCustomer = new URLSearchParams(location.search).has("table");
  if (!isCustomer && !sessionStorage.getItem("ff_staff_active")) {
     import("./supabase.js").then(({ supabase }) => {
         if (supabase) supabase.auth.signOut();
     });
  }

  const rerender = () => renderRoute(mount).catch(error => {
    console.error(error);
    mount.innerHTML = `
      <section class="error-screen">
        <div class="error-card">
          <i class="ph ph-warning-circle"></i>
          <h1>Something went wrong</h1>
          <p>${escapeHtml(error.message)}</p>
          <button class="btn btn-primary" data-reload><i class="ph ph-arrow-clockwise"></i>Reload</button>
        </div>
      </section>`;
    mount.querySelector("[data-reload]")?.addEventListener("click", () => location.reload());
  });

  window.addEventListener("popstate", rerender);
  window.addEventListener("hashchange", rerender);
  window.addEventListener("fourflavours:navigate", rerender);
  window.addEventListener("keydown", event => {
    const customer = new URLSearchParams(location.search).has("table");
    if (!customer && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      location.hash = "#/4";
    }
  });

  rerender();
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
