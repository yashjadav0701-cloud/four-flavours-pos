import { versionedAsset } from "../core/config.js";
import { getSession, supabase } from "../core/supabase.js";
import { showToast } from "./navigation.js";

// ==========================================
// TIER 1: STAFF POS LOGIN (Email & Password)
// ==========================================
export async function renderStaffLogin({ mount, onLogin }) {
  if (!supabase) return () => {};

  mount.innerHTML = `
    <section class="access-screen">
      <div class="access-card">
        <div class="access-brand">
          <img class="access-logo" src="${versionedAsset("assets/images/website_icon.svg")}" alt="Logo" />
          <div><span class="eyebrow">Staff System</span><strong>Four Flavours</strong></div>
        </div>
        <h1>POS Login</h1>
        <p class="access-copy">Sign in with your staff email and password to access the Point of Sale terminal.</p>
        <form id="staff-login-form" class="stack-form" style="display: flex; flex-direction: column; gap: 14px;">
          <label class="field"><span>Email</span><input class="field-input" id="staff-email" type="email" autocomplete="username" placeholder="staff@fourflavours.com" required autofocus /></label>
          <label class="field"><span>Password</span><input class="field-input" id="staff-password" type="password" autocomplete="current-password" placeholder="••••••••" required /></label>
          <button class="btn btn-dark btn-large" type="submit" style="width: 100%; margin-top: 8px;"><i class="ph-bold ph-sign-in"></i> Access POS</button>
          <div class="access-status" id="staff-status" style="text-align: center; margin-top: 10px;"></div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector("#staff-login-form");
  const status = mount.querySelector("#staff-status");

  form.addEventListener("submit", async event => {
    event.preventDefault();
    status.textContent = "Authenticating…";
    
    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.disabled = true;

    try {
      const email = mount.querySelector("#staff-email").value.trim();
      const password = mount.querySelector("#staff-password").value;
      
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error("Authentication failed.");
      
      onLogin(); // Trigger router to proceed to POS
    } catch (error) {
      submitBtn.disabled = false;
      status.textContent = "";
      showToast("Login failed", error.message, "error");
    }
  });

  return () => {};
}

// ==========================================
// TIER 2: ADMIN WORKSPACE UNLOCK (6-Digit PIN)
// ==========================================
export async function renderAdminLock({ mount, onUnlocked }) {
  mount.innerHTML = `
    <section class="access-screen">
      <div class="access-card">
        <div class="access-brand">
          <img class="access-logo" src="${versionedAsset("assets/images/website_icon.svg")}" alt="Logo" />
          <div><span class="eyebrow">Manager workspace</span><strong>Four Flavours</strong></div>
        </div>
        <h1>Secure admin access</h1>
        <p class="access-copy">Enter your 6-digit manager PIN to unlock the control centre.</p>
        <form id="admin-pin-form" class="stack-form" style="display: flex; flex-direction: column; gap: 14px;">
          <label class="field"><span>6-digit PIN</span><input class="field-input pin-input" id="admin-pin" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="••••••" required autofocus /></label>
          <button class="btn btn-dark btn-large" type="submit" style="width: 100%; margin-top: 8px;"><i class="ph-bold ph-lock-key"></i> Unlock workspace</button>
          <button class="btn btn-quiet" id="admin-back" type="button" style="width: 100%; margin-top: 8px;"><i class="ph-bold ph-arrow-left"></i> Return to POS</button>
          <div class="access-status" id="admin-status" style="text-align: center; margin-top: 10px;"></div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector("#admin-pin-form");
  const status = mount.querySelector("#admin-status");

  form.addEventListener("submit", async event => {
    event.preventDefault();
    status.textContent = "Verifying PIN…";
    
    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.disabled = true;

    try {
      const pin = mount.querySelector("#admin-pin").value.trim();
      const { data, error } = await supabase.rpc("verify_admin_pin", { p_pin: pin });
      
      if (error) throw error;
      if (data !== true) throw new Error("Invalid PIN or unauthorized.");
      
      onUnlocked(); // Render admin workspace
    } catch (error) {
      submitBtn.disabled = false;
      status.textContent = "";
      showToast("Access Denied", error.message, "error");
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
  // Maintained for backward compatibility
}