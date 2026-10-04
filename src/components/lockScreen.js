import { versionedAsset } from "../core/config.js";
import { getSession, supabase } from "../core/supabase.js";
import { showToast } from "./navigation.js";

export async function renderAdminLock({ mount, onUnlocked }) {
  if (!supabase) {
    mount.innerHTML = `<section class="access-screen"><div class="access-card"><img class="access-logo" src="${versionedAsset("assets/images/website_icon.svg")}" alt="" /><span class="eyebrow">Configuration required</span><h1>Connect Four Flavours</h1><p>Add the Supabase project URL and publishable/anon key in index.html.</p></div></section>`;
    return () => {};
  }

  const session = await getSession();
  
  // Auto-unlock logic has been intentionally removed.
  // The system will now ALWAYS ask for the 6-digit PIN on every visit.

  mount.innerHTML = `
    <section class="access-screen">
      <div class="access-card">
        <div class="access-brand">
          <img class="access-logo" src="${versionedAsset("assets/images/website_icon.svg")}" alt="" />
          <div><span class="eyebrow">Manager workspace</span><strong>Four Flavours</strong></div>
        </div>
        <h1>Secure admin access</h1>
        <p class="access-copy">Sign in with Supabase Auth and unlock the management workspace with your 6-digit manager PIN.</p>
        <form id="admin-access-form" class="stack-form">
          <label class="field ${session ? "is-hidden" : ""}"><span>Email</span><input class="field-input" id="admin-email" type="email" autocomplete="username" placeholder="admin@restaurant.com" ${session ? "disabled" : ""} required /></label>
          <label class="field ${session ? "is-hidden" : ""}"><span>Password</span><input class="field-input" id="admin-password" type="password" autocomplete="current-password" placeholder="Your Supabase password" ${session ? "disabled" : ""} required /></label>
          <label class="field"><span>6-digit PIN</span><input class="field-input pin-input" id="admin-pin" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="••••••" required /></label>
          <button class="btn btn-primary btn-large" type="submit"><i class="ph ph-lock-key"></i>Unlock workspace</button>
          <button class="btn btn-quiet" id="admin-back" type="button"><i class="ph ph-arrow-left"></i>Return to POS</button>
          <div class="access-status" id="admin-status"></div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector("#admin-access-form");
  const status = mount.querySelector("#admin-status");

  form.addEventListener("submit", async event => {
    event.preventDefault();
    status.textContent = "Authenticating…";
    try {
      let current = await getSession();
      if (!current) {
        const email = mount.querySelector("#admin-email").value.trim();
        const password = mount.querySelector("#admin-password").value;
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        current = data.session;
      }
      if (!current) throw new Error("Authentication session was not created.");
      const pin = mount.querySelector("#admin-pin").value.trim();
      const { data, error } = await supabase.rpc("verify_admin_pin", { p_pin: pin });
      if (error) throw error;
      if (data !== true) throw new Error("The PIN is invalid or this account is not a manager.");
      
      onUnlocked();
    } catch (error) {
      status.textContent = error.message;
      showToast("Admin access failed", error.message, "error");
    }
  });

  mount.querySelector("#admin-back").addEventListener("click", () => {
    history.pushState({}, "", location.pathname);
    location.hash = "";
    window.dispatchEvent(new Event("fourflavours:navigate"));
  });

  return () => {};
}

export function clearAdminUnlock() { 
  // Deprecated: PIN is now strictly required on every visit.
}