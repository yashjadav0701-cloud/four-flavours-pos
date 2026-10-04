import { supabase } from "../core/supabase.js";
import {
  DEFAULT_SETTINGS,
  versionedAsset,
  getCustomerTableUrl
} from "../core/config.js";
import { renderAdminLock } from "../components/lockScreen.js";
import {
  escapeHtml,
  money,
  mountNavigation,
  openAppModal,
  showToast
} from "../components/navigation.js";

const DISH_IMAGE_BUCKET = "dish-images";
const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_FINAL_IMAGE_BYTES = 2 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 350 * 1024;
const IMAGE_CACHE_SECONDS = 31536000;

async function decodeDishImage(file) {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(
        file,
        {
          imageOrientation: "from-image"
        }
      );

      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close()
      };
    } catch {
      // Fall through to HTMLImageElement decoding.
    }
  }

  const objectUrl =
    URL.createObjectURL(file);

  const image =
    new Image();

  image.decoding =
    "async";

  image.src =
    objectUrl;

  try {
    await image.decode();
  } catch {
    await new Promise(
      (resolve, reject) => {
        image.onload = resolve;
        image.onerror = () =>
          reject(
            new Error(
              "The selected image could not be decoded."
            )
          );
      }
    );
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () =>
      URL.revokeObjectURL(objectUrl)
  };
}

function canvasToWebp(
  canvas,
  quality
) {
  return new Promise(
    (resolve, reject) => {
      canvas.toBlob(
        blob => {
          if (!blob) {
            reject(
              new Error(
                "The browser could not create the optimized image."
              )
            );
            return;
          }

          if (blob.type !== "image/webp") {
            reject(
              new Error(
                "This browser cannot export WebP images. Please use a current Chrome, Edge, Safari or Firefox browser."
              )
            );
            return;
          }

          resolve(blob);
        },
        "image/webp",
        quality
      );
    }
  );
}

function drawDishCrop(
  source,
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight
) {
  const targetRatio =
    targetWidth / targetHeight;

  const sourceRatio =
    sourceWidth / sourceHeight;

  let cropWidth;
  let cropHeight;
  let cropX;
  let cropY;

  if (sourceRatio > targetRatio) {
    cropHeight =
      sourceHeight;

    cropWidth =
      sourceHeight *
      targetRatio;

    cropX =
      (sourceWidth - cropWidth) / 2;

    cropY = 0;
  } else {
    cropWidth =
      sourceWidth;

    cropHeight =
      sourceWidth /
      targetRatio;

    cropX = 0;

    cropY =
      (sourceHeight - cropHeight) / 2;
  }

  const canvas =
    document.createElement("canvas");

  canvas.width =
    targetWidth;

  canvas.height =
    targetHeight;

  const context =
    canvas.getContext("2d", {
      alpha: false
    });

  if (!context) {
    throw new Error(
      "The browser could not create an image canvas."
    );
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  context.drawImage(
    source,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    targetWidth,
    targetHeight
  );

  return canvas;
}

async function optimizeDishImage(file) {
  if (!file) {
    return null;
  }

  if (
    !file.type.startsWith("image/")
  ) {
    throw new Error(
      "Please select an image file."
    );
  }

  if (
    file.size >
    MAX_SOURCE_IMAGE_BYTES
  ) {
    throw new Error(
      "Please select an image smaller than 12 MB."
    );
  }

  const decoded =
    await decodeDishImage(file);

  try {
    if (
      !decoded.width ||
      !decoded.height
    ) {
      throw new Error(
        "The selected image has invalid dimensions."
      );
    }

    if (
      decoded.width *
      decoded.height >
      50_000_000
    ) {
      throw new Error(
        "The selected image has too many pixels. Please choose a smaller image."
      );
    }

    /*
     * Four Flavours uses ONE canonical source ratio:
     *
     *                 1200 × 900
     *                   4 : 3
     *
     * This keeps every dish visually consistent across desktop,
     * tablet and mobile while avoiding giant originals in Storage.
     */
    const profiles = [
      {
        width: 1200,
        height: 900,
        quality: 0.86
      },
      {
        width: 1200,
        height: 900,
        quality: 0.82
      },
      {
        width: 1200,
        height: 900,
        quality: 0.78
      },
      {
        width: 1200,
        height: 900,
        quality: 0.74
      },
      {
        width: 960,
        height: 720,
        quality: 0.82
      },
      {
        width: 960,
        height: 720,
        quality: 0.76
      },
      {
        width: 768,
        height: 576,
        quality: 0.78
      },
      {
        width: 768,
        height: 576,
        quality: 0.72
      }
    ];

    let lastBlob =
      null;

    for (const profile of profiles) {
      const canvas =
        drawDishCrop(
          decoded.source,
          decoded.width,
          decoded.height,
          profile.width,
          profile.height
        );

      const blob =
        await canvasToWebp(
          canvas,
          profile.quality
        );

      lastBlob =
        blob;

      /*
       * Target ≈350 KB for fast QR/customer loading.
       * Hard limit remains 2 MB because that is the bucket limit.
       */
      if (
        blob.size <=
        TARGET_IMAGE_BYTES
      ) {
        return new File(
          [blob],
          `dish-${crypto.randomUUID()}.webp`,
          {
            type: "image/webp",
            lastModified: Date.now()
          }
        );
      }

      if (
        blob.size <=
        MAX_FINAL_IMAGE_BYTES
        &&
        profile ===
          profiles[profiles.length - 1]
      ) {
        return new File(
          [blob],
          `dish-${crypto.randomUUID()}.webp`,
          {
            type: "image/webp",
            lastModified: Date.now()
          }
        );
      }
    }

    if (
      lastBlob &&
      lastBlob.size <=
        MAX_FINAL_IMAGE_BYTES
    ) {
      return new File(
        [lastBlob],
        `dish-${crypto.randomUUID()}.webp`,
        {
          type: "image/webp",
          lastModified: Date.now()
        }
      );
    }

    throw new Error(
      "The optimized image is still too large. Please select a simpler or smaller photo."
    );

  } finally {
    decoded.cleanup();
  }
}

function drawCuisineCrop(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  let cropWidth, cropHeight, cropX, cropY;

  if (sourceRatio > targetRatio) {
    // Image is wider than needed. Center-crop horizontally.
    cropHeight = sourceHeight;
    cropWidth = sourceHeight * targetRatio;
    cropX = (sourceWidth - cropWidth) / 2;
    cropY = 0;
  } else {
    // Image is taller than needed. Top-align to preserve text at the top!
    cropWidth = sourceWidth;
    cropHeight = sourceWidth / targetRatio;
    cropX = 0;
    cropY = 0; // 0 anchors it to the absolute top edge
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create an image canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
  return canvas;
}

async function optimizeCuisineImage(file) {
  if (!file) return null;
  if (!file.type.startsWith("image/")) throw new Error("Please select an image file.");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("Please select an image smaller than 12 MB.");

  const decoded = await decodeDishImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("The selected image has invalid dimensions.");
    if (decoded.width * decoded.height > 50_000_000) throw new Error("The selected image has too many pixels.");

    // Target ratio 3:4 (Standard portrait cards)
    const profiles = [
      { width: 1200, height: 1600, quality: 0.86 },
      { width: 1200, height: 1600, quality: 0.82 },
      { width: 960, height: 1280, quality: 0.82 },
      { width: 768, height: 1024, quality: 0.78 }
    ];

    let lastBlob = null;
    for (const profile of profiles) {
      const canvas = drawCuisineCrop(decoded.source, decoded.width, decoded.height, profile.width, profile.height);
      const blob = await canvasToWebp(canvas, profile.quality);
      lastBlob = blob;
      if (blob.size <= TARGET_IMAGE_BYTES) return new File([blob], `cuisine-${crypto.randomUUID()}.webp`, { type: "image/webp", lastModified: Date.now() });
      if (blob.size <= MAX_FINAL_IMAGE_BYTES && profile === profiles[profiles.length - 1]) return new File([blob], `cuisine-${crypto.randomUUID()}.webp`, { type: "image/webp", lastModified: Date.now() });
    }

    if (lastBlob && lastBlob.size <= MAX_FINAL_IMAGE_BYTES) return new File([lastBlob], `cuisine-${crypto.randomUUID()}.webp`, { type: "image/webp", lastModified: Date.now() });
    throw new Error("The optimized image is still too large.");
  } finally {
    decoded.cleanup();
  }
}

function storagePathFromUrl(
  value
) {
  const raw =
    String(value ?? "")
      .trim();

  if (!raw) {
    return null;
  }

  const marker =
    `/storage/v1/object/public/${DISH_IMAGE_BUCKET}/`;

  const index =
    raw.indexOf(marker);

  if (index >= 0) {
    return decodeURIComponent(
      raw
        .slice(
          index + marker.length
        )
        .split("?")[0]
    );
  }

  if (
    raw.startsWith("products/") ||
    raw.startsWith("cuisines/")
  ) {
    return raw;
  }

  return null;
}

function getDishPublicUrl(
  path
) {
  const {
    data
  } =
    supabase.storage
      .from(DISH_IMAGE_BUCKET)
      .getPublicUrl(path);

  return data.publicUrl;
}

export async function render({ mount }) {
  let cleanup = null;
  await renderAdminLock({
    mount,
    onUnlocked: async () => {
      cleanup = await renderAdminWorkspace(mount);
    }
  });
  return () => cleanup?.();
}

async function fetchWorkspace() {
  const [settings, products, tables, sessions, cuisines] = await Promise.all([
    supabase.from("app_settings").select("*").eq("id", 1).maybeSingle(),
    supabase.from("products").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }),
    supabase.from("tables").select("*").order("table_no", { ascending: true }),
    supabase.from("dining_sessions").select("*").neq("status", "closed").order("bill_requested_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }),
    supabase.from("cuisines").select("*").order("sort_order", { ascending: true })
  ]);
  for (const result of [settings, products, tables, sessions, cuisines]) if (result?.error) throw result.error;
  return { settings: { ...DEFAULT_SETTINGS, ...(settings.data ?? {}) }, products: products.data ?? [], tables: tables.data ?? [], sessions: sessions.data ?? [], cuisines: cuisines.data ?? [] };
}

async function renderAdminWorkspace(mount) {
  let { settings, products, tables, sessions, cuisines } = await fetchWorkspace();
  window.__FF_TABLES__ = tables;
  let section = "overview";

  mount.innerHTML = `
    <section class="admin-page">
      <header class="app-topbar admin-topbar">
        <div class="topbar-side topbar-left" style="gap: 12px;">
          <button class="icon-btn icon-btn-dark" id="admin-menu" title="Menu" aria-label="Menu" style="position: relative;">
            <i class="ph ph-list"></i>
            <span class="hamburger-dot" style="position: absolute; top: 4px; right: 4px; width: 8px; height: 8px; border-radius: 50%; background: #e11d48; display: none; border: 2px solid var(--paper);"></span>
          </button>
          <img src="${versionedAsset("assets/images/website_logo.svg")}" alt="Four Flavours" style="height: 40px; width: auto;" />
        </div>
        <div class="brand-center main-logo-only">
          <!-- Center logo safely removed to match POS layout -->
        </div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="admin-refresh" title="Refresh" aria-label="Refresh"><i class="ph ph-arrows-clockwise"></i></button>
        </div>
      </header>

      <nav class="admin-section-nav" id="admin-section-nav" aria-label="Management sections">
        <button data-section="overview" class="active"><i class="ph ph-fill ph-squares-four"></i><span>Overview</span></button>
        <button data-section="orders"><i class="ph ph-bold ph-receipt"></i><span>Orders</span></button>
        <button data-section="cuisines"><i class="ph ph-bold ph-image"></i><span>Cuisines</span></button>
        <button data-section="menu"><i class="ph ph-bold ph-fork-knife"></i><span>Menu</span></button>
        <button data-section="tables"><i class="ph ph-bold ph-armchair"></i><span>Tables</span></button>
        <button data-section="settings"><i class="ph ph-bold ph-gear"></i><span>Settings</span></button>
      </nav>
      <main class="admin-content"><section id="admin-area"></section></main>
    </section>`;

  const navCleanup = mountNavigation({ active: "admin" });
  const area = mount.querySelector("#admin-area");

  // Dynamically swaps hollow icons to filled icons for the active tab
  function updateNavUI() {
    mount.querySelectorAll("[data-section]").forEach(el => {
      const isActive = el.dataset.section === section;
      el.classList.toggle("active", isActive);
      const icon = el.querySelector("i");
      if (icon) {
        if (isActive) icon.className = icon.className.replace("ph-bold", "ph-fill");
        else icon.className = icon.className.replace("ph-fill", "ph-bold");
      }
    });
  }

  mount.querySelector("#admin-menu").addEventListener("click", () => window.__FOUR_FLAVOURS_NAV__?.open());
  
  mount.querySelector("#admin-refresh").addEventListener("click", async (e) => { 
    const btn = e.currentTarget;
    const icon = btn.querySelector("i");
    
    const blocker = document.createElement("div");
    blocker.className = "full-page-blocker";
    document.body.appendChild(blocker);
    
    btn.disabled = true;
    icon.classList.add("icon-spin");
    
    try {
      await reload(); 
      showToast("Workspace refreshed"); 
    } catch (err) {
      showToast("Refresh failed", err.message, "error");
    } finally {
      icon.classList.remove("icon-spin");
      btn.disabled = false;
      blocker.remove();
    }
  });

  mount.querySelector("#admin-section-nav").addEventListener("click", event => {
    const b = event.target.closest("[data-section]");
    if (!b) return;
    section = b.dataset.section;
    
    // Clear notification highlight when the admin views the Orders tab
    if (section === "orders") {
      b.style.color = "";
    }
    
    updateNavUI();
    renderSection();
  });

  async function reload() {
    ({ settings, products, tables, sessions, cuisines } = await fetchWorkspace());
    window.__FF_TABLES__ = tables;
    renderSection();
  }

  function renderSection() {
    if (section === "overview") renderOverview();
    if (section === "orders") renderOrders();
    if (section === "cuisines") renderCuisines();
    if (section === "menu") renderMenu();
    if (section === "tables") renderTables();
    if (section === "settings") renderSettings();
  }

  async function renderOrders() {
    area.innerHTML = `<section class="section-title-row"><div><span class="eyebrow">Order History</span><h1>All past bills.</h1><p>View, reprint, or permanently delete historical receipts from the database.</p></div></section><section class="admin-panel"><div class="admin-list-scroll" id="orders-list"><div class="empty-state"><i class="ph ph-spinner-gap"></i><strong>Loading orders...</strong></div></div></section>`;
    const list = area.querySelector("#orders-list");
    
    try {
      // Fetch orders and their nested items
      const { data: orders, error } = await supabase.from("orders").select("*, order_items(*)").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      
      if (!orders || orders.length === 0) {
        list.innerHTML = `<div class="empty-state"><i class="ph ph-receipt"></i><strong>No orders yet</strong><span>Completed orders will appear here.</span></div>`;
        return;
      }

      // 1. Load the list of bills the Admin has already clicked on from local memory
      const seenOrders = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_orders") || "[]"));
      
      // 2. We will flag any UNSEEN order generated in the last 12 hours
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60000);

      list.innerHTML = orders.map(o => {
        const orderDate = new Date(o.created_at);
        // It is only "New" if it is recent AND the admin hasn't clicked it yet
        const isNew = orderDate > twelveHoursAgo && !seenOrders.has(o.id);
        
        return `
        <article class="admin-order-data-row" style="${isNew ? 'border-color: var(--gold-400); background: var(--gold-100); box-shadow: 0 4px 16px rgba(201,164,90,0.2);' : ''}">
          <div class="order-cell-id" style="display: flex; align-items: center; gap: 8px;">
            <span style="${isNew ? 'color: var(--gold-600);' : ''}">Order #${escapeHtml(o.order_number)}</span>
            ${isNew ? `<span style="background: var(--gold-500); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; text-transform: uppercase;">New Bill</span>` : ''}
          </div>
          <div class="order-cell-date">${orderDate.toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</div>
          <div class="order-cell-type">${o.order_type === 'dine_in' ? `Dine-in · Table ${tables.find(t => t.id === o.table_id)?.table_no || 'Unknown'}` : 'Takeaway'} · ${o.order_items.length} ${o.order_items.length === 1 ? 'item' : 'items'}</div>
          <div class="order-cell-price">${money(o.grand_total, settings.currency_symbol)}</div>
          <div class="order-cell-actions">
            <button class="icon-btn icon-btn-light" data-view-order="${o.id}" title="View Receipt" style="${isNew ? 'background: #fff; border-color: var(--gold-400); color: var(--forest-900);' : ''}"><i class="ph-bold ph-printer"></i></button>
            <button class="icon-btn icon-btn-danger" data-delete-order="${o.id}" title="Delete Order"><i class="ph-bold ph-trash"></i></button>
          </div>
        </article>
      `}).join("");

      list.addEventListener("click", e => {
        const view = e.target.closest("[data-view-order]");
        const del = e.target.closest("[data-delete-order]");
        
        if (view) {
          const orderId = view.dataset.viewOrder;
          
          // 3. Mark the bill as SEEN the moment the admin clicks it
          const updatedSeen = new Set(JSON.parse(localStorage.getItem("fourflavours.seen_orders") || "[]"));
          updatedSeen.add(orderId);
          localStorage.setItem("fourflavours.seen_orders", JSON.stringify([...updatedSeen]));
          
          // Show the receipt modal and instantly refresh the list to drop the Gold highlight
          showAdminReceiptPreview(orders.find(x => x.id === orderId));
          renderOrders(); 
        }
        
        if (del) deleteOrder(orders.find(x => x.id === del.dataset.deleteOrder));
      });
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Error loading orders</strong><span>${escapeHtml(err.message)}</span></div>`;
    }
  }

  function deleteOrder(order) {
    openAppModal({
      title: `Delete Order #${order.order_number}?`,
      subtitle: "This will permanently remove the bill and its items from the database.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph ph-trash"></i></div><h3>Delete this record?</h3><p>This action cannot be undone.</p></div>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try {
            // Call our custom PostgreSQL function to bypass RLS and handle sequence resets
            const { error } = await supabase.rpc("delete_pos_order", { p_order_id: order.id });
            if (error) throw error;
            
            showToast("Order deleted", `Order #${order.order_number} has been completely removed.`);
            close();
            renderOrders();
          } catch(err) {
            button.disabled = false;
            showToast("Error", err.message, "error");
          }
        }}
      ]
    });
  }

  function showAdminReceiptPreview(order) {
    let tableString = "Takeaway";
    if (order.order_type === "dine_in" && order.table_id) {
      const t = tables.find(x => x.id === order.table_id);
      if (t) tableString = `Dine-in · Table ${t.table_no}`;
    }
    const date = new Date(order.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

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
            ${order.order_items.map(i => `
              <tr>
                <td style="text-align: left;">${escapeHtml(i.name_snapshot)}<br><small>${money(i.unit_price, settings.currency_symbol)}</small></td>
                <td style="text-align: center;">${i.quantity}</td>
                <td style="text-align: right;">${money(Number(i.unit_price) * Number(i.quantity), settings.currency_symbol)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div class="thermal-totals-wrap">
          <div class="thermal-line"><span>Subtotal</span><strong>${money(order.subtotal, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>CGST (${order.cgst_rate}%)</span><strong>${money(order.cgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>SGST (${order.sgst_rate}%)</span><strong>${money(order.sgst, settings.currency_symbol)}</strong></div>
          <div class="thermal-line"><span>Rounding</span><strong>${money(order.rounding, settings.currency_symbol)}</strong></div>
          <div class="thermal-line thermal-grand"><span>GRAND TOTAL</span><strong>${money(order.grand_total, settings.currency_symbol)}</strong></div>
        </div>
        ${settings.upi_id ? `
          <div class="thermal-payment-block">
            <div class="thermal-qr" id="admin-thermal-upi"></div>
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
      title: `Order #${order.order_number} Receipt`,
      subtitle: "Reprint, download, or view historical bill details.",
      body: `<div class="receipt-preview-container">${receiptHTML}</div>`,
      actions: [
        { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Download", icon: "ph-download-simple", className: "btn-quiet", onClick: async ({ root, button }) => {
            const element = root.querySelector("#thermal-receipt-content");
            button.disabled = true;
            const originalText = button.innerHTML;
            button.innerHTML = `<i class="ph ph-spinner-gap"></i><span>Saving...</span>`;
            try {
              if (!window.html2pdf) {
                await new Promise((resolve) => {
                  const script = document.createElement("script");
                  script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
                  script.onload = resolve;
                  document.head.appendChild(script);
                });
              }
              
              // Temporarily remove shadow and margin so they don't push the PDF onto a second page
              const oldShadow = element.style.boxShadow;
              const oldMargin = element.style.margin;
              element.style.boxShadow = "none";
              element.style.margin = "0";
              
              // Use getBoundingClientRect for exact sub-pixel accuracy after stripping the margin
              const exactHeight = element.getBoundingClientRect().height;
              const heightInMM = (exactHeight * 0.264583) + 1; // Just 1mm buffer for absolute safety
              
              const opt = {
                margin: 0,
                filename: `FourFlavours_Bill_#${order.order_number}.pdf`,
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 4, useCORS: true }, 
                jsPDF: { unit: 'mm', format: [80, heightInMM], orientation: 'portrait' }
              };
              
              await html2pdf().set(opt).from(element).save();
              
              // Restore UI styles instantly after generation
              element.style.boxShadow = oldShadow;
              element.style.margin = oldMargin;
            } catch (err) {
              console.error("PDF Generation failed:", err);
            } finally {
              button.disabled = false;
              button.innerHTML = originalText;
            }
        }},
        { label: "Print", icon: "ph-printer", className: "btn-primary", onClick: () => {
            const host = document.querySelector("#receipt-print-host");
            if (host) { host.innerHTML = modal.root.querySelector("#thermal-receipt-content").outerHTML; window.print(); }
        }}
      ]
    });

    if (settings.upi_id && globalThis.QRCode) {
      setTimeout(() => {
        const qr = modal.root.querySelector("#admin-thermal-upi");
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

  function renderCuisines() {
    area.innerHTML = `
      <section class="section-title-row"><div><span class="eyebrow">Cuisine Backgrounds</span><h1>Main menu categories.</h1><p>Upload beautiful background images for the 4 main cuisines. These appear as large cards on the customer and POS screens.</p></div></section>
      <section class="admin-panel"><div class="admin-list-scroll" id="cuisine-list"></div></section>`;
    const list = area.querySelector("#cuisine-list");
    list.innerHTML = cuisines.length ? cuisines.map(cuisine => `<article class="admin-product-row"><div class="admin-product-image">${cuisine.image_url ? `<img src="${versionedAsset(cuisine.image_url)}" alt="">` : `<div class="product-placeholder"><i class="ph ph-image"></i></div>`}</div><div class="admin-product-main"><div class="admin-product-title"><div><strong>${escapeHtml(cuisine.name)}</strong></div></div></div><div class="admin-product-actions"><button class="icon-btn icon-btn-light" data-edit-cuisine="${cuisine.id}" title="Upload image" aria-label="Upload image"><i class="ph ph-upload-simple"></i></button></div></article>`).join("") : `<div class="empty-state"><strong>No cuisines configured in the database.</strong></div>`;
    list.addEventListener("click", e => { const b = e.target.closest("[data-edit-cuisine]"); if (!b) return; const c = cuisines.find(x => x.id === b.dataset.editCuisine); if (c) openCuisineEditor(c); });
  }

  function openCuisineEditor(cuisine) {
    const currentImageUrl = cuisine?.image_url ? versionedAsset(cuisine.image_url) : "";
    const currentImageHtml = currentImageUrl ? `<div class="image-upload-preview" id="cuisine-preview"><img src="${currentImageUrl}" alt="" /><div class="image-preview-copy"><strong>Current background</strong><span>Upload another to replace.</span></div></div>` : `<div class="image-upload-preview empty" id="cuisine-preview"><i class="ph ph-image"></i><div class="image-preview-copy"><strong>No image yet</strong><span>Add a background photo.</span></div></div>`;
    const modal = openAppModal({
      title: `Edit ${escapeHtml(cuisine.name)} image`,
      subtitle: "Photos are automatically cropped to 4:5 and optimized.",
      body: `<form id="cuisine-form" class="stack-form"><div class="field"><span>Background Image</span><label class="image-upload-zone"><input id="cuisine-image" type="file" accept="image/*" /><span class="image-upload-icon"><i class="ph ph-cloud-arrow-up"></i></span><span class="image-upload-copy"><strong>Choose photo</strong><small>JPG, PNG, WebP · optimized automatically</small></span></label>${currentImageHtml}<div class="image-upload-status" id="cuisine-upload-status"></div></div></form>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Save image", icon: "ph-floppy-disk", className: "btn-primary", onClick: async ({ root, close, button }) => {
          const fileInput = root.querySelector("#cuisine-image");
          const selectedFile = fileInput?.files?.[0];
          if (!selectedFile) { close(); return; }
          button.disabled = true;
          const statusNode = root.querySelector("#cuisine-upload-status");
          try {
            statusNode.innerHTML = `<i class="ph ph-spinner-gap"></i><span>Optimizing...</span>`;
            const optimizedFile = await optimizeCuisineImage(selectedFile);
            const newStoragePath = `cuisines/${cuisine.id}/${crypto.randomUUID()}.webp`;
            statusNode.innerHTML = `<i class="ph ph-cloud-arrow-up"></i><span>Uploading...</span>`;
            const { error: uploadError } = await supabase.storage.from(DISH_IMAGE_BUCKET).upload(newStoragePath, optimizedFile, { contentType: "image/webp", upsert: false });
            if (uploadError) throw uploadError;
            const finalImageUrl = getDishPublicUrl(newStoragePath);
            const { error: dbError } = await supabase.from("cuisines").update({ image_url: finalImageUrl }).eq("id", cuisine.id);
            if (dbError) throw dbError;
            const oldPath = storagePathFromUrl(cuisine.image_url);
            if (oldPath) {
              const { error: cleanupError } = await supabase.storage.from(DISH_IMAGE_BUCKET).remove([oldPath]);
              if (cleanupError) console.warn("Failed to delete old cuisine image:", cleanupError);
            }
            showToast("Cuisine updated");
            close();
            await reload();
          } catch (error) { button.disabled = false; statusNode.innerHTML = `<i class="ph ph-warning-circle"></i><span>${escapeHtml(error.message)}</span>`; }
        }}
      ]
    });
    modal.root.querySelector("#cuisine-image")?.addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      const preview = modal.root.querySelector("#cuisine-preview");
      preview.classList.remove("empty");
      preview.innerHTML = `<img src="${previewUrl}" alt=""><div class="image-preview-copy"><strong>New image selected</strong><span>${escapeHtml(file.name)}</span></div>`;
    });
  }

  function renderOverview() {
    const activeProducts = products.filter(p => p.is_active).length;
    const activeTables = tables.filter(t => t.is_active).length;
    const billRequests = sessions.filter(s => s.status === "bill_requested").length;
    
    // Inject the Dynamic Customer Activity Inbox
    const alertsHtml = window.__adminAlerts && window.__adminAlerts.length > 0 ? `
      <section class="admin-panel" style="margin-bottom: 16px; border-color: var(--gold-400); background: var(--gold-100); box-shadow: 0 4px 16px rgba(201,164,90,0.2);">
         <div class="panel-head" style="margin-bottom: 12px; align-items: center;">
           <div><span class="eyebrow" style="color: var(--gold-600);">Customer Activity Inbox</span><h2 style="color: var(--forest-950); display: flex; align-items: center; gap: 8px; margin-top: 4px;"><i class="ph-fill ph-bell-ringing qty-pulse" style="color: var(--gold-500);"></i> Needs Attention</h2></div>
           <button class="btn btn-quiet btn-small" id="clear-admin-alerts" style="background: #fff; border-color: var(--gold-400); color: var(--forest-900); font-weight: 800; cursor: pointer;">Clear Inbox</button>
         </div>
         <div class="quick-action-grid">
           ${window.__adminAlerts.map((a, index) => `
             <button class="quick-action" data-alert-index="${index}" ${a.tableId ? `data-alert-table-id="${escapeHtml(a.tableId)}"` : `data-go="orders"`} style="background: #fff; border-left: 4px solid var(--gold-500); grid-template-columns: minmax(0,1fr) auto; border-radius: 10px; cursor: pointer; padding: 12px;">
                <div style="min-width: 0; text-align: left;">
                  <strong style="font-size: 14px; color: var(--forest-950);">${escapeHtml(a.title)}</strong>
                  <span style="display: block; font-size: 13px; color: var(--muted); margin-top: 2px;">${escapeHtml(a.message)}</span>
                </div>
                <i class="ph-bold ph-arrow-right" style="color: var(--gold-500); font-size: 18px;"></i>
             </button>
           `).join("")}
         </div>
      </section>
    ` : "";

    area.innerHTML = `
      ${alertsHtml}
      <section class="admin-hero" style="${alertsHtml ? 'padding-top: 0;' : ''}"><div><span class="eyebrow">Control centre</span><h1>Everything in its place.</h1><p>Menu, tables, tax, UPI and table sessions in one restrained workspace.</p></div><div class="admin-hero-mark"><img src="${versionedAsset("assets/images/website_icon.svg")}" alt=""></div></section>
      <section class="metric-grid">${metricCard("ph-fork-knife", activeProducts, "Active dishes")}${metricCard("ph-armchair", activeTables, "Active tables")}${metricCard("ph-bell", sessions.length, "Open sessions")}${metricCard("ph-receipt", billRequests, "Bill requests")}</section>
      <section class="admin-grid-two">
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Quick actions</span><h2>Run the floor</h2></div></div><div class="quick-action-grid"><button class="quick-action" data-go="tables"><i class="ph ph-armchair"></i><span><strong>Manage tables</strong><small>Add, edit, delete and print QR codes.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="menu"><i class="ph ph-fork-knife"></i><span><strong>Manage menu</strong><small>Names, descriptions, prices and visibility.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="settings"><i class="ph ph-gear"></i><span><strong>Tax & UPI</strong><small>Keep server-side billing settings current.</small></span><i class="ph ph-arrow-right"></i></button></div></article>
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Dining sessions</span><h2>Open tables</h2></div><span class="soft-badge">${sessions.length} active</span></div><div class="session-mini-scroll" id="overview-session-list">
          ${sessions.length ? sessions.map(s => `
            <div class="admin-mini-row" style="padding: 16px 12px; border: 1px solid ${s.status === 'bill_requested' ? 'var(--gold-400)' : 'var(--line)'}; border-radius: 14px; margin-bottom: 8px; background: ${s.status === 'bill_requested' ? 'var(--gold-100)' : 'var(--paper)'}; ${s.status === 'bill_requested' ? 'box-shadow: 0 4px 16px rgba(201,164,90,0.25);' : ''}">
              <div class="mini-row-icon" style="${s.status === 'bill_requested' ? 'background: var(--gold-400); color: #fff;' : ''}"><i class="ph-bold ${s.status === 'bill_requested' ? 'ph-bell-ringing qty-pulse' : 'ph-armchair'}"></i></div>
              <div style="flex: 1; margin-left: 14px;">
                <strong style="font-size: 15px; ${s.status === 'bill_requested' ? 'color: var(--gold-600);' : ''}">Table ${escapeHtml(tables.find(t => t.id === s.table_id)?.table_no ?? "—")}</strong>
                <span style="font-size: 12px; color: ${s.status === 'bill_requested' ? 'var(--gold-600)' : 'var(--muted)'}; font-weight: ${s.status === 'bill_requested' ? '800' : 'normal'};">${s.status === "bill_requested" ? "Customer requested bill!" : s.status === "bill_ready" ? "Bill ready" : "Dining session open"}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 14px;">
                <button class="${s.status === 'bill_requested' ? 'btn btn-primary btn-small qty-pulse' : 'btn btn-primary btn-small'}" data-manage-session="${s.id}">Manage</button>
              </div>
            </div>
          `).join("") : `<div class="empty-state compact"><i class="ph ph-circle-wavy-check"></i><strong>No open table sessions</strong><span>The floor is currently clear.</span></div>`}
        </div></article>
      </section>`;
    
    area.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => { section = b.dataset.go; updateNavUI(); renderSection(); }));
    
    // INTELLIGENT ALERT ROUTING & DISMISSAL
    area.querySelectorAll("[data-alert-index]").forEach(btn => {
      btn.addEventListener("click", () => {
         // 1. Remove the alert from the inbox instantly
         const idx = Number(btn.dataset.alertIndex);
         if (window.__adminAlerts && window.__adminAlerts[idx]) {
             window.__adminAlerts.splice(idx, 1);
             window.__unreadAdminCount = window.__adminAlerts.length;
             if (window.updateGlobalNotificationBadge) window.updateGlobalNotificationBadge();
         }

         // 2. Route to the correct destination
         const tId = btn.dataset.alertTableId;
         if (tId) {
             const table = tables.find(x => x.id === tId);
             const session = sessions.find(x => x.table_id === tId && x.status !== 'closed');
             
             if (table && session) {
                 openAdminTableManager(table, session);
                 renderOverview(); // Update UI to hide the alert box seamlessly
             } else {
                 section = "orders"; 
                 updateNavUI(); 
                 renderSection();
             }
         } else {
             section = "orders"; 
             updateNavUI(); 
             renderSection();
         }
      });
    });
    
    area.querySelector("#overview-session-list")?.addEventListener("click", e => {
      const row = e.target.closest("[data-manage-session]");
      if (!row) return;
      const session = sessions.find(x => x.id === row.dataset.manageSession);
      const table = tables.find(x => x.id === session?.table_id);
      if (table && session) openAdminTableManager(table, session);
    });
    
    area.querySelector("#clear-admin-alerts")?.addEventListener("click", () => {
      if (window.clearGlobalNotification) window.clearGlobalNotification();
      renderOverview();
    });
  }

  function renderMenu() {
    area.innerHTML = `
      <section class="section-title-row" style="flex-wrap: wrap; gap: 16px;">
        <div style="flex: 1; min-width: 280px;">
          <span class="eyebrow">Menu management</span>
          <h1>Every dish, neatly managed.</h1>
          <p>Long lists stay inside a contained vertical workspace instead of stretching the entire page.</p>
        </div>
        <div style="display: flex !important; flex-direction: row !important; gap: 12px !important; flex-wrap: nowrap !important; align-items: center; justify-content: flex-start; width: auto !important;">
          <button class="btn btn-quiet" id="generate-menu-pdf" style="height: 44px; border-radius: 10px; font-weight: 800; padding: 0 20px; white-space: nowrap; border: 1px solid var(--forest-900); color: var(--forest-900); background: #ffffff; box-shadow: 0 2px 6px rgba(0,0,0,0.05); flex: 0 0 auto !important; width: auto !important;"><i class="ph-bold ph-file-pdf"></i> Full Menu PDF</button>
          <button class="btn btn-primary" id="add-product" style="height: 44px; border-radius: 10px; font-weight: 800; padding: 0 20px; white-space: nowrap; flex: 0 0 auto !important; width: auto !important;"><i class="ph-bold ph-plus"></i> Add dish</button>
        </div>
      </section>
      <section class="admin-panel"><div class="panel-toolbar"><div class="search-wrap light"><i class="ph ph-magnifying-glass"></i><input class="search-input" id="product-search" type="search" placeholder="Search dishes or categories"></div><span class="soft-badge">${products.length} dishes</span></div><div class="admin-list-scroll" id="product-list"></div></section>`;
    
    const search = area.querySelector("#product-search");
    const list = area.querySelector("#product-list");

    area.querySelector("#generate-menu-pdf").addEventListener("click", () => openMenuPDFPreview());
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const visible = products.filter(p => !q || `${p.name} ${p.category} ${p.description ?? ""}`.toLowerCase().includes(q));
      
      list.innerHTML = visible.length ? visible.map(product => `
        <article class="admin-product-row" style="align-items: center;">
          <div class="admin-product-image">${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="" loading="lazy">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}</div>
          <div class="admin-product-main">
            <div class="admin-product-title"><div><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)}</span></div><strong style="font-size: 16px;">${money(product.price)}</strong></div>
            <p>${escapeHtml(product.description ?? "")}</p>
            <div style="margin-top: 8px;"><span class="active-badge ${product.is_active ? "active" : ""}"><span></span>${product.is_active ? "Live" : "Hidden"}</span></div>
          </div>
          
          <div class="admin-product-actions" style="display: flex; flex-direction: column; gap: 8px; align-items: center; padding-left: 16px; border-left: 1px solid var(--line); margin-left: 12px;">
            <button data-edit-product="${product.id}" title="Edit dish" style="width: 36px; height: 36px; padding: 0; border-radius: 10px; background: #f8fafc; border: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: center; color: var(--forest-800); font-size: 18px; cursor: pointer; transition: transform 0.1s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.03);" onmousedown="this.style.transform='scale(0.92)'" onmouseup="this.style.transform='scale(1)'" onmouseleave="this.style.transform='scale(1)'">
              <i class="ph-bold ph-pencil-simple"></i>
            </button>
            <button data-delete-product="${product.id}" title="Delete dish" style="width: 36px; height: 36px; padding: 0; border-radius: 10px; background: #fff1f2; border: 1px solid #ffe4e6; display: flex; align-items: center; justify-content: center; color: #e11d48; font-size: 18px; cursor: pointer; transition: transform 0.1s ease; box-shadow: 0 1px 2px rgba(225,29,72,0.03);" onmousedown="this.style.transform='scale(0.92)'" onmouseup="this.style.transform='scale(1)'" onmouseleave="this.style.transform='scale(1)'">
              <i class="ph-bold ph-trash"></i>
            </button>
          </div>
          
        </article>`).join("") : `<div class="empty-state"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try another search.</span></div>`;
    };
    
    search.addEventListener("input", paint); paint();
    area.querySelector("#add-product").addEventListener("click", () => openProductEditor());
    
    function openMenuPDFPreview() {
      const activeProducts = products.filter(p => p.is_active).sort((a,b) => a.sort_order - b.sort_order);
      
      const targetCuisines = ["Indian", "Chinese", "Continental", "Mexican"];
      const menuTree = {};
      const cuisineItemCounts = {};
      
      targetCuisines.forEach(c => { 
          menuTree[c] = {}; 
          cuisineItemCounts[c] = 0; 
      });

      // Group active dishes and accurately count the total items in each cuisine
      activeProducts.forEach(p => {
         const parts = String(p.category || "").split(" - ");
         const cName = parts[0]?.trim();
         const subName = parts[1]?.trim() || "Others";
         const targetCuisine = targetCuisines.includes(cName) ? cName : "Continental";
         
         if (!menuTree[targetCuisine][subName]) menuTree[targetCuisine][subName] = [];
         menuTree[targetCuisine][subName].push(p);
         cuisineItemCounts[targetCuisine]++;
      });
      
      function getSubcatIcon(name) {
         const n = name.toLowerCase();
         if (n.includes('starter') || n.includes('appetizer')) return 'ph-fire';
         if (n.includes('bread') || n.includes('roti') || n.includes('naan')) return 'ph-bread';
         if (n.includes('rice') || n.includes('biryani')) return 'ph-bowl-steam';
         if (n.includes('soup')) return 'ph-bowl-food';
         if (n.includes('main')) return 'ph-cooking-pot';
         if (n.includes('noodle')) return 'ph-waves';
         if (n.includes('pasta')) return 'ph-spiral';
         if (n.includes('pizza')) return 'ph-pizza';
         if (n.includes('dessert') || n.includes('sweet')) return 'ph-ice-cream';
         if (n.includes('beverage') || n.includes('drink')) return 'ph-brandy';
         if (n.includes('wrap') || n.includes('roll')) return 'ph-hamburger';
         if (n.includes('bowl')) return 'ph-orange-slice';
         return 'ph-star';
      }

      const columnsHtml = targetCuisines.map(cuisineName => {
         const flexWeight = Math.max(12, cuisineItemCounts[cuisineName]);
         
         // THE PACKING ALGORITHM: Sort subcategories by Item Count (Descending)
         // This guarantees the largest lists fill the primary columns on the left first, eliminating massive empty spaces!
         const subCats = Object.keys(menuTree[cuisineName]).sort((a, b) => {
             return menuTree[cuisineName][b].length - menuTree[cuisineName][a].length;
         });

         if (subCats.length === 0) return `<div class="a0-cuisine-col" style="flex: ${flexWeight};"><h2 class="a0-cuisine-title">${escapeHtml(cuisineName)}</h2><div style="text-align: center; color: var(--muted); font-size: 24px;">Coming Soon</div></div>`;
         
         const subCatsHtml = subCats.map(subCat => {
            const itemsHtml = menuTree[cuisineName][subCat].map(p => `
               <div class="a0-item">
                  ${p.image_url ? `<img src="${versionedAsset(p.image_url)}" class="a0-item-thumb">` : `<div class="a0-item-placeholder"><i class="ph-bold ph-fork-knife"></i></div>`}
                  <div class="a0-item-details">
                     <div class="a0-item-header">
                        <span class="a0-item-name">${escapeHtml(p.name)}</span>
                        <span class="a0-item-leader"></span>
                        <span class="a0-item-price">${money(p.price, settings.currency_symbol)}</span>
                     </div>
                     ${p.description ? `<div class="a0-item-desc">${escapeHtml(p.description)}</div>` : ''}
                  </div>
               </div>
            `).join("");
            
            return `<div class="a0-subcat-wrap"><h3 class="a0-subcat-title"><i class="ph-fill ${getSubcatIcon(subCat)}"></i> ${escapeHtml(subCat)}</h3>${itemsHtml}</div>`;
         }).join("");
         
         return `<div class="a0-cuisine-col" style="flex: ${flexWeight};"><h2 class="a0-cuisine-title">${escapeHtml(cuisineName)}</h2><div class="a0-masonry-wrapper">${subCatsHtml}</div></div>`;
      }).join("");

      const canvasHtml = `
         <div class="a0-canvas" id="a0-print-target">
            <header class="a0-header">
               <div class="a0-logo-box"><img src="${versionedAsset("assets/images/website_logo.svg")}" class="a0-logo" alt="Logo"></div>
            </header>
            <div class="a0-grid">
               ${columnsHtml}
            </div>
         </div>
         <div class="a0-viewer-hints"><i class="ph-bold ph-hand-pointing"></i> Drag to pan · Scroll/Pinch to zoom</div>
      `;

      const modal = openAppModal({
         title: "A0 Menu Board",
         subtitle: "Drag to pan. Scroll to zoom. The layout is pixel-perfect.",
         body: `<div class="a0-preview-viewport" id="a0-preview-viewport">${canvasHtml}</div>`,
         actions: [
            { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
            { label: "Download High-Res PDF", icon: "ph-download-simple", className: "btn-primary", onClick: async ({ root, button }) => {
               const element = root.querySelector("#a0-print-target");
               
               button.disabled = true;
               const originalText = button.innerHTML;
               button.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i><span>Generating PDF...</span>`;
               
               try {
                  if (!window.html2pdf) {
                     await new Promise((resolve) => {
                        const script = document.createElement("script");
                        script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
                        script.onload = resolve;
                        document.head.appendChild(script);
                     });
                  }

                  // 1. Create a pristine container at the absolute root of the document
                  const printContainer = document.createElement("div");
                  printContainer.style.position = "absolute";
                  printContainer.style.top = "0";
                  printContainer.style.left = "0";
                  printContainer.style.width = "4400px";
                  printContainer.style.zIndex = "-9999"; 
                  printContainer.style.background = "#0c1a11";

                  // 2. Clone the element and strip the pan/zoom transform physics
                  const clone = element.cloneNode(true);
                  clone.style.transform = "none";
                  clone.style.margin = "0";
                  // CRITICAL FIX: Ensure document flow is respected so height doesn't collapse to 0
                  clone.style.position = "relative"; 

                  printContainer.appendChild(clone);
                  document.body.appendChild(printContainer);

                  // 3. Give the browser 400ms to completely paint the new DOM and images
                  await new Promise(r => setTimeout(r, 400));

                  const renderWidthPx = clone.scrollWidth;
                  const renderHeightPx = clone.scrollHeight;
                  
                  // Convert pixels to exact millimeters
                  const widthMm = renderWidthPx * 0.264583;
                  const heightMm = renderHeightPx * 0.264583;

                  // 4. THE LIMIT FIX: 
                  // By dropping scale to 1.5, we get a 6600px canvas, safely under the 8192px browser limit.
                  // This allows html2pdf to process and directly download the file without the print dialog!
                  const opt = {
                     margin: 0,
                     filename: `FourFlavours_Premium_Menu.pdf`,
                     image: { type: 'jpeg', quality: 1 },
                     html2canvas: { 
                         scale: 1.5, 
                         useCORS: true, 
                         logging: false, 
                         backgroundColor: '#0c1a11',
                         width: renderWidthPx,
                         height: renderHeightPx,
                         windowWidth: renderWidthPx,
                         windowHeight: renderHeightPx
                     },
                     jsPDF: { unit: 'mm', format: [widthMm, heightMm], orientation: widthMm > heightMm ? 'landscape' : 'portrait' }
                  };
                  
                  await html2pdf().set(opt).from(clone).save();
                  
                  // 5. Cleanup the temporary clone instantly after download triggers
                  document.body.removeChild(printContainer);
               } catch (err) {
                  console.error("PDF Generation failed:", err);
                  showToast("Generation Error", "Failed to compile PDF.", "error");
               } finally {
                  button.disabled = false;
                  button.innerHTML = originalText;
               }
            }}
         ]
      });

      // PHYSICS ENGINE: Complete Pan & Zoom Architecture
      const viewport = modal.root.querySelector("#a0-preview-viewport");
      const canvas = modal.root.querySelector("#a0-print-target");
      if (!viewport || !canvas) return;
      
      let scale = 0, translateX = 0, translateY = 0, isDragging = false, startX, startY;
      
      function fitToScreen() {
         const vW = viewport.clientWidth;
         const vH = viewport.clientHeight;
         const cW = canvas.scrollWidth;
         const cH = canvas.scrollHeight;
         
         const scaleX = vW / cW;
         const scaleY = vH / cH;
         scale = Math.min(scaleX, scaleY) * 0.95; // 95% perfect fit to view everything
         
         translateX = (vW - (cW * scale)) / 2;
         translateY = (vH - (cH * scale)) / 2;
         updateTransform();
      }
      
      function updateTransform() {
         canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      }
      
      setTimeout(fitToScreen, 50);
      window.addEventListener("resize", fitToScreen);

      // Desktop Scroll Zoom
      viewport.addEventListener("wheel", e => {
         e.preventDefault();
         const delta = e.deltaY * -0.002;
         let newScale = Math.max(0.05, Math.min(scale * Math.exp(delta), 2));
         
         const rect = viewport.getBoundingClientRect();
         const pointerX = e.clientX - rect.left;
         const pointerY = e.clientY - rect.top;
         
         // Zoom into pointer
         translateX = pointerX - (pointerX - translateX) * (newScale / scale);
         translateY = pointerY - (pointerY - translateY) * (newScale / scale);
         scale = newScale;
         updateTransform();
      }, { passive: false });

      // Unified Mouse/Touch Pan Dragging
      viewport.addEventListener("pointerdown", e => {
         isDragging = true;
         startX = e.clientX - translateX;
         startY = e.clientY - translateY;
         viewport.setPointerCapture(e.pointerId);
      });
      viewport.addEventListener("pointermove", e => {
         if (!isDragging) return;
         translateX = e.clientX - startX;
         translateY = e.clientY - startY;
         updateTransform();
      });
      viewport.addEventListener("pointerup", () => { isDragging = false; });

      // Mobile Pinch to Zoom
      let initialDistance = null;
      let initialScale = null;
      
      viewport.addEventListener("touchstart", e => {
         if (e.touches.length === 2) {
             isDragging = false; 
             initialDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
             initialScale = scale;
         }
      }, { passive: false });
      
      viewport.addEventListener("touchmove", e => {
         if (e.touches.length === 2 && initialDistance) {
             e.preventDefault();
             const currentDistance = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
             let newScale = Math.max(0.05, Math.min(initialScale * (currentDistance / initialDistance), 2));
             
             const rect = viewport.getBoundingClientRect();
             const pointerX = rect.width / 2;
             const pointerY = rect.height / 2;
             
             translateX = pointerX - (pointerX - translateX) * (newScale / scale);
             translateY = pointerY - (pointerY - translateY) * (newScale / scale);
             scale = newScale;
             updateTransform();
         }
      }, { passive: false });
      
      viewport.addEventListener("touchend", e => { if (e.touches.length < 2) { initialDistance = null; initialScale = null; } });
      
      const originalClose = modal.close;
      modal.close = () => { window.removeEventListener("resize", fitToScreen); originalClose(); };
    }

    list.addEventListener("click", e => { 
      const editBtn = e.target.closest("[data-edit-product]"); 
      const delBtn = e.target.closest("[data-delete-product]");
      if (editBtn) { const p = products.find(x => x.id === editBtn.dataset.editProduct); if (p) openProductEditor(p); } 
      if (delBtn) { const p = products.find(x => x.id === delBtn.dataset.deleteProduct); if (p) openProductDelete(p); }
    });
  }

  function renderTables() {
    area.innerHTML = `
      <section class="section-title-row"><div><span class="eyebrow">Floor layout</span><h1>Live Table Management.</h1><p>Monitor occupied tables, force-close abandoned sessions, and manage your floor plan.</p></div><button class="btn btn-primary" id="add-table"><i class="ph-bold ph-plus"></i>Add table</button></section>
      <section class="admin-panel"><div class="panel-toolbar"><span class="soft-badge">${tables.length} tables</span><span class="panel-help"><i class="ph ph-qr-code"></i> Production QR Available</span></div><div class="admin-table-scroll" id="table-list"></div></section>`;
    
    const list = area.querySelector("#table-list");
    const activeSessions = sessions.filter(s => s.status !== "closed");

    list.innerHTML = tables.length ? tables.map(t => {
      const openSession = activeSessions.find(s => s.table_id === t.id);
      const isBillReq = openSession?.status === "bill_requested";
      
      return `
        <article class="table-admin-card ${isBillReq ? 'bill-requested-card' : openSession ? 'occupied-card' : ''} ${t.is_active ? "" : "inactive"}">
          <div class="table-badge">
            <i class="ph-bold ph-armchair"></i>
            <strong>${escapeHtml(t.table_no)}</strong>
          </div>
          <div class="table-card-main">
            <div>
              <span class="eyebrow">Capacity: ${Number(t.capacity)}</span>
              ${openSession 
                ? `<strong style="color: var(--danger);">Occupied</strong>`
                : `<strong>Empty</strong>`
              }
            </div>
            ${openSession
              ? `<span class="table-state active" style="color: var(--danger);"><span></span>Session Active</span>`
              : `<span class="table-state ${t.is_active ? "active" : "inactive"}"><span></span>${t.is_active ? "Ready" : "Hidden"}</span>`
            }
          </div>
          <div class="table-card-actions">
            ${openSession
              ? `<button class="btn btn-primary btn-small" data-manage-table="${t.id}"><i class="ph-bold ph-list-magnifying-glass"></i> Manage</button>`
              : `
                ${t.is_active ? `<button class="icon-btn icon-btn-light" data-qr="${t.id}" title="Table QR"><i class="ph-bold ph-qr-code"></i></button>` : ""}
                <button class="icon-btn icon-btn-light" data-edit-table="${t.id}" title="Edit table"><i class="ph-bold ph-pencil-simple"></i></button>
                <button class="icon-btn icon-btn-danger" data-delete-table="${t.id}" title="Delete table"><i class="ph-bold ph-trash"></i></button>
              `
            }
          </div>
        </article>
      `
    }).join("") : `<div class="empty-state"><i class="ph-bold ph-armchair"></i><strong>No tables yet</strong><span>Create the first table to generate a QR.</span></div>`;

    area.querySelector("#add-table").addEventListener("click", () => openTableEditor());
    
    list.addEventListener("click", e => {
      const edit = e.target.closest("[data-edit-table]");
      const del = e.target.closest("[data-delete-table]");
      const qr = e.target.closest("[data-qr]");
      const manageTbl = e.target.closest("[data-manage-table]");
      
      if (edit) { const t = tables.find(x => x.id === edit.dataset.editTable); if (t) openTableEditor(t); }
      if (del) { const t = tables.find(x => x.id === del.dataset.deleteTable); if (t) openTableDelete(t); }
      if (qr) { const t = tables.find(x => x.id === qr.dataset.qr); if (t) openTableQR(t); }
      if (manageTbl) { 
        const t = tables.find(x => x.id === manageTbl.dataset.manageTable);
        const s = activeSessions.find(x => x.table_id === t.id);
        if (t && s) openAdminTableManager(t, s); 
      }
    });
  }

  async function openAdminTableManager(table, session) {
    const modal = openAppModal({
      title: `Table ${table.table_no} Management`,
      subtitle: "Review the active table tab, add items, or close the table.",
      body: `<div id="admin-table-manager-host" style="display: flex; flex-direction: column; min-height: 50vh;"><div class="empty-state"><i class="ph ph-spinner-gap ph-spin"></i><strong>Loading table data...</strong></div></div>`,
      actions: [] // Strip default actions to merge them into a unified sticky block
    });

    const host = modal.root.querySelector("#admin-table-manager-host");
    
    async function renderManager() {
      try {
        // FETCH ALL ORDERS: Aggregate every round the customer ordered into one Master Tab
        const { data: ordersList, error } = await supabase.from("orders").select("*, order_items(*)").eq("session_id", session.id).neq("status", "cancelled").order("created_at", { ascending: true });
        if (error) throw error;

        if (!ordersList || ordersList.length === 0) {
          host.innerHTML = `
            <div style="display: flex; flex-direction: column; flex: 1;">
              <div class="empty-state"><i class="ph ph-warning-circle"></i><strong>No active order found</strong><span>The table session was opened, but no items were sent to the kitchen.</span></div>
              <div style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: flex; gap: 8px;">
                <button class="btn btn-primary" id="admin-add-items" style="flex: 1;"><i class="ph-bold ph-plus"></i> Add Items</button> 
                <button class="btn btn-danger" id="force-close-empty" style="flex: 1;"><i class="ph-bold ph-power"></i> Close Table</button>
              </div>
            </div>`;
          
          host.querySelector("#force-close-empty").addEventListener("click", async () => {
             await supabase.from("dining_sessions").update({ status: 'closed' }).eq("id", session.id);
             modal.close();
             reload();
          });
          
          host.querySelector("#admin-add-items").addEventListener("click", () => {
             modal.close();
             window.__FOUR_FLAVOURS_POS_STATE__?.setOrderType('dine_in');
             window.__FOUR_FLAVOURS_POS_STATE__?.setTable(table);
             document.querySelector('[data-nav="pos"]')?.click();
          });
          return;
        }

        let tempMap = new Map();
        let grandTotal = 0, subtotal = 0, cgst = 0, sgst = 0, rounding = 0;
        let latestOrder = ordersList[ordersList.length - 1]; // We append new items to the latest round

        ordersList.forEach(o => {
          grandTotal += Number(o.grand_total || 0);
          subtotal += Number(o.subtotal || 0);
          cgst += Number(o.cgst || 0);
          sgst += Number(o.sgst || 0);
          rounding += Number(o.rounding || 0);
          
          // SORTING FIX: Force the items to sort by ID so Admin additions ALWAYS appear at the bottom!
          const items = o.order_items || [];
          items.sort((a, b) => a.id - b.id);
          
          items.forEach(oi => {
            const pId = oi.product_id;
            const qty = Number(oi.quantity);
            if (tempMap.has(pId)) {
               tempMap.get(pId).quantity += qty;
            } else {
               tempMap.set(pId, { id: pId, name: oi.name_snapshot, price: oi.unit_price, quantity: qty });
            }
          });
        });

        const displayItems = Array.from(tempMap.values());
        const isBillReq = session.status === "bill_requested";

        host.innerHTML = `
          <div class="active-dining-dashboard" style="text-align: left; display: flex; flex-direction: column; flex: 1;">
            <div class="dining-status-banner" style="${isBillReq ? 'background: var(--gold-100); color: var(--gold-600); border: 1px solid var(--gold-400);' : ''}">
              <i class="ph-bold ph-${isBillReq ? 'bell-ringing qty-pulse' : 'receipt'}"></i>
              <div>
                <strong style="${isBillReq ? 'color: var(--gold-600);' : ''}">${isBillReq ? 'Customer Requested Bill' : 'Table Tab is open'}</strong>
                <span>Grand Total: ${money(grandTotal, settings.currency_symbol)}</span>
              </div>
            </div>
            <h3 class="dining-section-title">Customer's Order Items</h3>
            <div class="dining-items-list" style="max-height: 45vh; overflow-y: auto; margin-bottom: 0; padding-bottom: 12px;">
              ${displayItems.map(i => `
                <div class="dining-item-row" style="padding-right: 12px; align-items: center;">
                  <div class="dining-item-info">
                    <strong>${escapeHtml(i.name)} <span class="qty-badge">x${i.quantity}</span></strong>
                    <span>${money(i.price, settings.currency_symbol)}</span>
                  </div>
                  <button class="btn-primary btn-sm admin-repeat-btn" data-id="${i.id}" data-name="${escapeHtml(i.name)}" data-price="${i.price}" style="padding: 4px 12px; font-size: 12px; border-radius: 6px;">
                    <i class="ph-bold ph-arrow-counter-clockwise"></i> Repeat
                  </button>
                </div>
              `).join("")}
            </div>
            
            <!-- STICKY FOOTER (Merged Actions & Dead Space Eliminated) -->
            <div style="position: sticky; bottom: -17px; background: var(--paper); padding: 12px 0 0 0; margin-top: auto; border-top: 1px solid var(--line); display: flex; gap: 8px;">
              <button class="btn btn-quiet" id="admin-add-items" style="flex: 1; padding: 0 4px; font-size: 12px;"><i class="ph-bold ph-plus"></i> Add Items</button>
              <button class="btn btn-quiet" id="admin-view-bill" style="flex: 1; padding: 0 4px; font-size: 12px;"><i class="ph-bold ph-printer"></i> Bill</button>
              <button class="btn btn-primary" id="admin-close-table" style="flex: 1.5; padding: 0 4px; font-size: 12px;"><i class="ph-bold ph-check-circle"></i> Close Table</button>
            </div>
          </div>
        `;

        // REPEAT BUTTON LOGIC
        host.querySelectorAll(".admin-repeat-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
            btn.disabled = true;
            btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i>`;
            try {
              // Intelligent Merge Sync: Fetch existing items to prevent wiping the bill
              const { data: existingItems } = await supabase.from("order_items").select("*").eq("order_id", latestOrder.id);
              const mergedMap = new Map();
              
              if (existingItems) {
                  existingItems.forEach(item => {
                      mergedMap.set(item.product_id, {
                          id: item.product_id, product_id: item.product_id,
                          name: item.name_snapshot, name_snapshot: item.name_snapshot,
                          price: item.unit_price, unit_price: item.unit_price, quantity: item.quantity
                      });
                  });
              }
              
              const pId = btn.dataset.id;
              if (mergedMap.has(pId)) {
                  mergedMap.get(pId).quantity += 1;
              } else {
                  mergedMap.set(pId, { 
                      id: pId, product_id: pId, 
                      name: btn.dataset.name, name_snapshot: btn.dataset.name, 
                      price: btn.dataset.price, unit_price: btn.dataset.price, quantity: 1 
                  });
              }
              
              const { error } = await supabase.rpc('sync_pos_order', { 
                  p_order_id: latestOrder.id, 
                  p_items: Array.from(mergedMap.values()) 
              });
              if (error) throw error;
              
              showToast("Item Repeated", `${btn.dataset.name} added to Table ${table.table_no}`);
              renderManager(); // Refresh Admin drawer instantly
            } catch (err) {
              showToast("Error", err.message, "error");
              btn.disabled = false;
              btn.innerHTML = `<i class="ph-bold ph-arrow-counter-clockwise"></i> Repeat`;
            }
          });
        });

        // QUICK ADD ITEMS LOGIC
        host.querySelector("#admin-add-items").addEventListener("click", () => {
           const allActiveProducts = products.filter(p => p.is_active);
           
           function renderAdminItemList(list) {
              if (!list || !list.length) return `<div class="empty-state compact"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong></div>`;
              return list.map(p => `
                 <div style="display:flex; justify-content:space-between; align-items:center; padding: 14px 0; border-bottom: 1px solid var(--cream-200);">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                       <strong style="font-size: 14px; color: var(--forest-950);">${escapeHtml(p.name)}</strong>
                       <span style="font-size:12.5px; color:var(--muted);">${money(p.price, settings.currency_symbol)}</span>
                    </div>
                    <button class="btn btn-quiet btn-small admin-quick-add-btn" data-quick-add="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${p.price}"><i class="ph-bold ph-plus"></i> Add 1</button>
                 </div>
              `).join("");
           }

           host.innerHTML = `
             <div class="admin-add-item-list" style="text-align: left;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
                   <button class="icon-btn icon-btn-light" id="back-to-manager"><i class="ph-bold ph-arrow-left"></i></button>
                   <h3 style="margin: 0; font-size: 16px;">Add Items to Table ${escapeHtml(table.table_no)}</h3>
                </div>
                <div class="search-input-wrap" style="margin-bottom: 16px;">
                  <i class="ph-bold ph-magnifying-glass"></i>
                  <input type="text" id="admin-item-search" placeholder="Search menu..." style="width:100%; border:none; background:transparent; outline:none; font-size: 15px; font-weight:700;">
                </div>
                <div id="admin-item-grid" style="max-height: 48vh; overflow-y: auto; padding-right: 8px;">
                  ${renderAdminItemList(allActiveProducts)}
                </div>
             </div>
           `;
           
           host.querySelector("#back-to-manager").addEventListener("click", renderManager);
           
           host.querySelector("#admin-item-search").addEventListener("input", (e) => {
              const q = e.target.value.toLowerCase();
              const filtered = allActiveProducts.filter(p => p.name.toLowerCase().includes(q));
              host.querySelector("#admin-item-grid").innerHTML = renderAdminItemList(filtered);
           });

           host.querySelectorAll(".admin-quick-add-btn").forEach(btn => {
              btn.addEventListener("click", async () => {
                 window.__STAFF_MUTED_UNTIL = Date.now() + 3000;
                 btn.disabled = true;
                 btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i>`;
                 try {
                    // Intelligent Merge Sync
                    const { data: existingItems } = await supabase.from("order_items").select("*").eq("order_id", latestOrder.id);
                    const mergedMap = new Map();
                    
                    if (existingItems) {
                        existingItems.forEach(item => {
                            mergedMap.set(item.product_id, {
                                id: item.product_id, product_id: item.product_id,
                                name: item.name_snapshot, name_snapshot: item.name_snapshot,
                                price: item.unit_price, unit_price: item.unit_price, quantity: item.quantity
                            });
                        });
                    }
                    
                    const pId = btn.dataset.quickAdd;
                    if (mergedMap.has(pId)) {
                        mergedMap.get(pId).quantity += 1;
                    } else {
                        mergedMap.set(pId, { 
                            id: pId, product_id: pId, 
                            name: btn.dataset.name, name_snapshot: btn.dataset.name, 
                            price: btn.dataset.price, unit_price: btn.dataset.price, quantity: 1 
                        });
                    }
                    
                    const { error } = await supabase.rpc('sync_pos_order', { 
                        p_order_id: latestOrder.id, 
                        p_items: Array.from(mergedMap.values()) 
                    });
                    if (error) throw error;
                    
                    showToast("Item Added", `${btn.dataset.name} sent to Table ${table.table_no}`);
                    renderManager(); // Refresh Admin drawer instantly
                 } catch (err) {
                    showToast("Error", err.message, "error");
                    btn.disabled = false;
                    btn.innerHTML = `<i class="ph-bold ph-plus"></i> Add 1`;
                 }
              });
           });
        });

        // VIEW FULL BILL LOGIC
        host.querySelector("#admin-view-bill").addEventListener("click", () => {
           showAdminReceiptPreview({
             ...latestOrder, 
             order_items: displayItems.map(i => ({ name_snapshot: i.name, unit_price: i.price, quantity: i.quantity })),
             subtotal, cgst, sgst, rounding, grand_total: grandTotal
           });
        });

        // CLOSE TABLE LOGIC
        host.querySelector("#admin-close-table").addEventListener("click", () => {
           openAppModal({
              title: `Close Table ${table.table_no}?`,
              subtitle: "This marks the session as paid and frees the table for the next customer.",
              body: `<div class="danger-confirm"><div class="danger-confirm-icon" style="background: var(--success-soft); color: var(--success);"><i class="ph-bold ph-check-circle"></i></div><h3>Payment Received?</h3><p>Ensure the customer has paid ${money(grandTotal, settings.currency_symbol)} before closing.</p></div>`,
              actions: [
                { label: "Cancel", className: "btn-quiet", onClick: (ctx) => ctx.close() },
                { label: "Yes, Close Table", className: "btn-primary", onClick: async (ctx) => {
                    ctx.button.disabled = true;
                    try {
                      const { error } = await supabase.rpc("complete_session_payment", { p_session_id: session.id, p_payment_method: "cash" });
                      if (error) throw error;
                      showToast("Table Closed", `Table ${table.table_no} is now available.`);
                      ctx.close();
                      modal.close();
                      reload();
                    } catch(err) {
                      ctx.button.disabled = false;
                      showToast("Error", err.message, "error");
                    }
                }}
              ]
           });
        });

      } catch (err) {
        host.innerHTML = `<div class="empty-state"><i class="ph ph-warning-circle"></i><strong>Error loading table</strong><span>${escapeHtml(err.message)}</span></div>`;
      }
    }
    
    renderManager();
  }

  function renderSettings() {
    area.innerHTML = `
      <section class="section-title-row" style="flex-direction: row !important; justify-content: space-between !important; align-items: flex-end !important; text-align: left !important;">
        <div style="align-items: flex-start !important; text-align: left !important;">
          <span class="eyebrow">Restaurant settings</span>
          <h1 style="text-align: left !important; margin: 6px 0;">Keep the bill precise.</h1>
          <p style="text-align: left !important;">Database-verified tax and totals.</p>
        </div>
        <button class="btn btn-danger" id="admin-sign-out" style="flex-shrink: 0;"><i class="ph-bold ph-sign-out"></i>Sign out</button>
      </section>
      <section class="admin-panel settings-panel">
        <form id="settings-form" class="settings-form-grid">
          <label class="field"><span>Restaurant name</span><input class="field-input" name="restaurant_name" value="${escapeHtml(settings.restaurant_name)}" required></label>
          <label class="field"><span>UPI ID</span><input class="field-input" name="upi_id" value="${escapeHtml(settings.upi_id || "")}" placeholder="fourflavours@upi"></label>
          <label class="field"><span>GSTIN (GST Number)</span><input class="field-input" name="gst_number" value="${escapeHtml(settings.gst_number || "")}" placeholder="22AAAAA0000A1Z5"></label>
          <label class="field settings-wide"><span>Restaurant Address (Prints on Bill)</span><textarea class="field-input textarea-input" name="restaurant_address" placeholder="123 Food Street, City, State" rows="2">${escapeHtml(settings.restaurant_address || "")}</textarea></label>
          <label class="field"><span>CGST %</span><input class="field-input" name="cgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.cgst_rate)}" required></label>
          <label class="field"><span>SGST %</span><input class="field-input" name="sgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.sgst_rate)}" required></label>
          <label class="field settings-wide"><span>Receipt footer</span><input class="field-input" name="receipt_footer" value="${escapeHtml(settings.receipt_footer || "")}"></label>
          <div class="settings-wide settings-preview"><div class="settings-preview-icon"><i class="ph ph-shield-check"></i></div><div><strong>Secure calculation</strong><span>Prices, tax rates and the final total are recalculated by PostgreSQL when the order is created.</span></div></div>
          <div class="settings-wide"><button class="btn btn-primary" type="submit"><i class="ph ph-floppy-disk"></i>Save settings</button></div>
        </form>
      </section>`;

    area.querySelector("#admin-sign-out").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.innerHTML = `<i class="ph ph-spinner-gap ph-spin"></i><span>Signing out...</span>`;
      btn.disabled = true;
      try {
        await supabase.auth.signOut();
        window.location.href = "/";
      } catch (error) {
        showToast("Sign out failed", error.message, "error");
        btn.innerHTML = `<i class="ph-bold ph-sign-out"></i>Sign out`;
        btn.disabled = false;
      }
    });

    area.querySelector("#settings-form").addEventListener("submit", async e => {
      e.preventDefault(); const fd = new FormData(e.currentTarget);
      const payload = { 
        restaurant_name: String(fd.get("restaurant_name") || "").trim(), 
        upi_id: String(fd.get("upi_id") || "").trim(),
        gst_number: String(fd.get("gst_number") || "").trim(),
        restaurant_address: String(fd.get("restaurant_address") || "").trim(),
        cgst_rate: Number(fd.get("cgst_rate")), 
        sgst_rate: Number(fd.get("sgst_rate")), 
        receipt_footer: String(fd.get("receipt_footer") || "").trim() 
      };
      try { const { error } = await supabase.from("app_settings").update(payload).eq("id", 1); if (error) throw error; Object.assign(settings, payload); showToast("Settings saved", "Configuration updated."); } catch (error) { showToast("Could not save settings", error.message, "error"); }
    });
  }

  function openTableEditor(table = null) {
    const editing = Boolean(table);
    openAppModal({
      title: editing ? "Edit table" : "Add table",
      subtitle: editing ? "Update the table without leaving the workspace." : "Create a table and generate its QR automatically.",
      body: `<form id="table-form" class="stack-form"><label class="field"><span>Table number</span><input class="field-input" name="table_no" value="${escapeHtml(table?.table_no ?? "")}" placeholder="1, A1, VIP-1" required></label><label class="field"><span>Capacity</span><input class="field-input" name="capacity" type="number" min="1" max="100" value="${Number(table?.capacity ?? 4)}" required></label><label class="switch-field"><input type="checkbox" name="is_active" ${table?.is_active ?? true ? "checked" : ""}><span class="switch-ui"></span><span><strong>Table is active</strong><small>Inactive tables cannot accept QR orders.</small></span></label><div class="modal-form-note"><i class="ph ph-qr-code"></i><span>The QR remains tied to the table ID, so changing the displayed number does not change the QR destination.</span></div></form>`,
      actions: [
        { label: "Cancel", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: editing ? "Save changes" : "Create table", icon: "ph-floppy-disk", className: "btn-primary", onClick: async ({ root, close, button }) => {
          const form = root.querySelector("#table-form"); if (!form.reportValidity()) return; button.disabled = true; const fd = new FormData(form); const payload = { table_no: String(fd.get("table_no") || "").trim(), capacity: Number(fd.get("capacity")), is_active: fd.get("is_active") === "on" };
          try { const query = editing ? supabase.from("tables").update(payload).eq("id", table.id) : supabase.from("tables").insert(payload); const { error } = await query; if (error) throw error; showToast(editing ? "Table updated" : "Table created", `Table ${payload.table_no} is ready.`); close(); await reload(); } catch (error) { button.disabled = false; showToast("Could not save table", error.message, "error"); }
        }}
      ]
    });
  }

  function openTableDelete(table) {
    openAppModal({
      title: `Delete table ${escapeHtml(table.table_no)}?`,
      subtitle: "This action uses Four Flavours' own confirmation screen.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph ph-trash"></i></div><h3>Remove this table from management?</h3><p>The QR will stop accepting new orders. Historical orders remain in the database, but their table reference may become empty.</p><div class="modal-form-note warning"><i class="ph ph-warning-circle"></i><span>If this table currently has an open dining session, finish that session first.</span></div></div>`,
      actions: [
        { label: "Keep table", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete table", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try { const { data: openSessions, error: sessionError } = await supabase.from("dining_sessions").select("id").eq("table_id", table.id).neq("status", "closed").limit(1); if (sessionError) throw sessionError; if (openSessions?.length) throw new Error("This table has an open dining session. Close that session before deleting the table."); const { error } = await supabase.from("tables").delete().eq("id", table.id); if (error) throw error; showToast("Table deleted", `Table ${table.table_no} was removed.`); close(); await reload(); } catch (error) { button.disabled = false; showToast("Could not delete table", error.message, "error"); }
        }}
      ]
    });
  }

  function openTableQR(table) {
    const url = getCustomerTableUrl(table.id);
    const modal = openAppModal({
      title: `Table ${escapeHtml(table.table_no)} QR`,
      subtitle: "This QR always opens the live Four Flavours menu for this specific table.",
      body: `
        <div class="qr-preview-panel">
          <div class="qr-preview" id="table-qr"></div>
          <div class="qr-table-title">Table ${escapeHtml(table.table_no)}</div>
          <div class="qr-url">${escapeHtml(url)}</div>
          <div class="qr-safety-note">
            <i class="ph ph-shield-check"></i>
            <span>Production QR · Opens only the Four Flavours customer menu for this table.</span>
          </div>
        </div>
      `,
      actions: [
        { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { 
          label: "Download", 
          icon: "ph-download-simple", 
          className: "btn-quiet", 
          onClick: () => { 
            showToast("Generating...", "Preparing high-res QR code.");
            
            // Create a temporary, ultra-high-res QR code just for downloading
            const tempDiv = document.createElement("div");
            new QRCode(tempDiv, { 
              text: url, 
              width: 1024, 
              height: 1024, 
              correctLevel: QRCode.CorrectLevel.M 
            });
            
            setTimeout(() => {
              const qrCanvas = tempDiv.querySelector("canvas");
              if (qrCanvas) {
                const padding = 120; // Creates a massive, clean margin for printing
                const targetSize = qrCanvas.width + (padding * 2);
                
                const exportCanvas = document.createElement("canvas");
                exportCanvas.width = targetSize;
                exportCanvas.height = targetSize;
                const ctx = exportCanvas.getContext("2d");
                
                // Fill pure white background (Required for JPGs)
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, targetSize, targetSize);
                
                // Draw the crisp 1024x1024 QR code in the dead center
                ctx.drawImage(qrCanvas, padding, padding);
                
                // Export as Max Quality JPG
                const link = document.createElement("a");
                link.download = `Table-${table.table_no}-QR.jpg`;
                link.href = exportCanvas.toDataURL("image/jpeg", 1.0);
                link.click();
                
                showToast("Downloaded", `Table ${table.table_no} high-res JPG saved.`);
              } else {
                showToast("Error", "Could not generate QR Code.", "error");
              }
            }, 100);
          } 
        },
        { 
          label: "Print QR", 
          icon: "ph-printer", 
          className: "btn-primary", 
          onClick: ({ button }) => { 
            button.disabled = true; 
            const host = document.querySelector("#qr-print-host"); 
            const qr = modal.root.querySelector("#table-qr"); 
            host.innerHTML = `<section class="qr-print-sheet"><img src="${versionedAsset("assets/images/website_icon.svg")}" alt=""><h1>Four Flavours</h1><h2>Table ${escapeHtml(table.table_no)}</h2><div class="qr-print-code">${qr.innerHTML}</div><p>Scan to view the menu & order</p></section>`; 
            document.body.classList.add("print-qr"); 
            window.print(); 
            setTimeout(() => { document.body.classList.remove("print-qr"); host.innerHTML = ""; button.disabled = false; }, 800); 
          } 
        }
      ]
    });

    // We force clear the container to guarantee no injected logos push the QR code out of the box
    setTimeout(() => {
      if (globalThis.QRCode) {
        const container = modal.root.querySelector("#table-qr");
        container.innerHTML = ""; 
        new QRCode(container, { 
          text: url, 
          width: 256, 
          height: 256, 
          correctLevel: QRCode.CorrectLevel.M 
        });
      }
    }, 50);
  }

  function openProductDelete(product) {
    openAppModal({
      title: `Delete ${escapeHtml(product.name)}?`,
      subtitle: "This will permanently remove the dish from your active menu.",
      body: `<div class="danger-confirm"><div class="danger-confirm-icon"><i class="ph-bold ph-trash"></i></div><h3>Remove from menu?</h3><p>This action cannot be undone. Historical orders will still retain the item name on their receipts.</p></div>`,
      actions: [
        { label: "Cancel", icon: "ph-arrow-left", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Delete dish", icon: "ph-trash", className: "btn-danger", onClick: async ({ close, button }) => {
          button.disabled = true;
          try { 
            const { error } = await supabase.from("products").delete().eq("id", product.id); 
            if (error) throw error; 
            
            // Cleanup the image from storage to prevent orphaned files taking up space
            const storagePath = storagePathFromUrl(product.image_url);
            if (storagePath) {
              await supabase.storage.from(DISH_IMAGE_BUCKET).remove([storagePath]);
            }

            showToast("Dish deleted", `${product.name} was removed.`); 
            close(); 
            await reload(); 
          } catch (error) { 
            button.disabled = false; 
            showToast("Could not delete dish", error.message, "error"); 
          }
        }}
      ]
    });
  }

  function openProductEditor(product = null) {
    const editing =
      Boolean(product);

    const currentImageUrl =
      product?.image_url
        ? versionedAsset(product.image_url)
        : "";

    const currentImageHtml =
      currentImageUrl
        ? `
          <div
            class="image-upload-preview"
            id="image-preview"
          >
            <img
              src="${currentImageUrl}"
              alt=""
            />

            <div class="image-preview-copy">
              <strong>Current dish image</strong>
              <span>
                Upload another image below to replace it.
              </span>
            </div>
          </div>
        `
        : `
          <div
            class="image-upload-preview empty"
            id="image-preview"
          >
            <i class="ph ph-image"></i>

            <div class="image-preview-copy">
              <strong>No dish image yet</strong>
              <span>
                Add a clear food photograph for the customer menu.
              </span>
            </div>
          </div>
        `;

    const modal =
      openAppModal({
        title:
          editing
            ? "Edit dish"
            : "Add dish",

        subtitle:
          "Dish photos are automatically cropped to 4:3, optimized and stored as WebP.",

        body: `
          <form
            id="product-form"
            class="stack-form"
          >
            <label class="field">
              <span>Dish name</span>

              <input
                class="field-input"
                name="name"
                value="${escapeHtml(product?.name ?? "")}"
                required
              />
            </label>

            <div class="form-grid-two">
              <label class="field">
                <span>Category</span>

                <input
                  class="field-input"
                  name="category"
                  value="${escapeHtml(product?.category ?? "")}"
                  required
                />
              </label>

              <label class="field">
                <span>Price (₹)</span>

                <input
                  class="field-input"
                  name="price"
                  type="number"
                  min="0"
                  step="0.01"
                  value="${Number(product?.price ?? 0)}"
                  required
                />
              </label>
            </div>

            <label class="field">
              <span>Description</span>

              <textarea
                class="field-input textarea-input"
                name="description"
                maxlength="240"
                placeholder="A short, appetising description for customers"
              >${escapeHtml(product?.description ?? "")}</textarea>
            </label>

            <div class="field">
              <span>Dish image</span>

              <label
                class="image-upload-zone"
                data-image-zone
              >
                <input
                  id="product-image"
                  name="product_image"
                  type="file"
                  accept="image/*"
                />

                <span class="image-upload-icon">
                  <i class="ph ph-cloud-arrow-up"></i>
                </span>

                <span class="image-upload-copy">
                  <strong>
                    Choose dish photo
                  </strong>

                  <small>
                    JPG, PNG, WebP, etc. · automatically converted to
                    optimized 4:3 WebP
                  </small>
                </span>

                <span class="image-upload-arrow">
                  <i class="ph ph-arrow-up-right"></i>
                </span>
              </label>

              ${currentImageHtml}

              ${
                editing &&
                product?.image_url
                  ? `
                    <label class="switch-field image-remove-switch">
                      <input
                        type="checkbox"
                        name="remove_image"
                        id="remove-image"
                      />

                      <span class="switch-ui"></span>

                      <span>
                        <strong>
                          Remove current image
                        </strong>

                        <small>
                          The dish will remain available without a photo.
                        </small>
                      </span>
                    </label>
                  `
                  : ""
              }

              <div
                class="image-upload-status"
                id="image-upload-status"
              >
                <i class="ph ph-sparkle"></i>
                <span>
                  Best result: clear dish photo with the food near the centre.
                </span>
              </div>
            </div>

            <div class="inline-switch-grid">
              <label class="switch-field">
                <input
                  type="checkbox"
                  name="is_active"
                  ${product?.is_active ?? true ? "checked" : ""}
                />

                <span class="switch-ui"></span>

                <span>
                  <strong>Visible</strong>
                  <small>
                    Show this dish on the customer menu.
                  </small>
                </span>
              </label>

              <label class="switch-field">
                <input
                  type="checkbox"
                  name="tax_exempt"
                  ${product?.tax_exempt ? "checked" : ""}
                />

                <span class="switch-ui"></span>

                <span>
                  <strong>Tax exempt</strong>
                  <small>
                    Exclude it from GST calculations.
                  </small>
                </span>
              </label>
            </div>
          </form>
        `,

        actions: [
          {
            label: "Cancel",
            icon: "ph-x",
            className: "btn-quiet",

            onClick: ({
              close
            }) => close()
          },

          {
            label:
              editing
                ? "Save changes"
                : "Create dish",

            icon:
              "ph-floppy-disk",

            className:
              "btn-primary",

            onClick:
              async ({
                root,
                close,
                button
              }) => {
                const form =
                  root.querySelector(
                    "#product-form"
                  );

                if (
                  !form.reportValidity()
                ) {
                  return;
                }

                button.disabled =
                  true;

                const statusNode =
                  root.querySelector(
                    "#image-upload-status"
                  );

                const fileInput =
                  root.querySelector(
                    "#product-image"
                  );

                const removeImage =
                  root.querySelector(
                    "#remove-image"
                  );

                const selectedFile =
                  fileInput?.files?.[0] ??
                  null;

                const shouldRemoveImage =
                  Boolean(
                    removeImage?.checked
                  );

                if (
                  selectedFile &&
                  shouldRemoveImage
                ) {
                  removeImage.checked =
                    false;
                }

                const finalRemoveImage =
                  Boolean(
                    removeImage?.checked
                  );

                const fd =
                  new FormData(form);

                const productId =
                  editing
                    ? product.id
                    : crypto.randomUUID();

                let newStoragePath =
                  null;

                let previousStoragePath =
                  storagePathFromUrl(
                    product?.image_url
                  );

                let finalImageUrl =
                  product?.image_url ??
                  null;

                try {
                  const payload = {
                    id: productId,

                    name:
                      String(
                        fd.get("name") ||
                        ""
                      ).trim(),

                    category:
                      String(
                        fd.get("category") ||
                        ""
                      ).trim(),

                    price:
                      Number(
                        fd.get("price")
                      ),

                    description:
                      String(
                        fd.get("description") ||
                        ""
                      ).trim(),

                    image_url:
                      finalImageUrl,

                    is_active:
                      fd.get("is_active") ===
                      "on",

                    tax_exempt:
                      fd.get("tax_exempt") ===
                      "on"
                  };

                  if (
                    finalRemoveImage &&
                    !selectedFile
                  ) {
                    payload.image_url =
                      null;

                    finalImageUrl =
                      null;
                  }

                  if (
                    selectedFile
                  ) {
                    statusNode.innerHTML = `
                      <i class="ph ph-spinner-gap"></i>
                      <span>
                        Optimizing image…
                      </span>
                    `;

                    const optimizedFile =
                      await optimizeDishImage(
                        selectedFile
                      );

                    statusNode.innerHTML = `
                      <i class="ph ph-cloud-arrow-up"></i>
                      <span>
                        Uploading optimized WebP…
                      </span>
                    `;

                    /*
                     * NEVER overwrite the previous file.
                     *
                     * New unique path = immediate CDN freshness.
                     */
                    newStoragePath =
                      `products/${productId}/${crypto.randomUUID()}.webp`;

                    const {
                      error:
                        uploadError
                    } =
                      await supabase.storage
                        .from(
                          DISH_IMAGE_BUCKET
                        )
                        .upload(
                          newStoragePath,
                          optimizedFile,
                          {
                            cacheControl:
                              String(
                                IMAGE_CACHE_SECONDS
                              ),

                            contentType:
                              "image/webp",

                            upsert:
                              false
                          }
                        );

                    if (
                      uploadError
                    ) {
                      throw uploadError;
                    }

                    finalImageUrl =
                      getDishPublicUrl(
                        newStoragePath
                      );

                    payload.image_url =
                      finalImageUrl;
                  }

                  statusNode.innerHTML = `
                    <i class="ph ph-floppy-disk"></i>
                    <span>
                      Saving dish…
                    </span>
                  `;

                  const query =
                    editing
                      ? supabase
                          .from("products")
                          .update(
                            {
                              name:
                                payload.name,

                              category:
                                payload.category,

                              price:
                                payload.price,

                              description:
                                payload.description,

                              image_url:
                                payload.image_url,

                              is_active:
                                payload.is_active,

                              tax_exempt:
                                payload.tax_exempt
                            }
                          )
                          .eq(
                            "id",
                            product.id
                          )
                      : supabase
                          .from("products")
                          .insert(
                            payload
                          );

                  const {
                    error
                  } =
                    await query;

                  if (error) {
                    throw error;
                  }

                  /*
                   * Remove the old Storage object only after the database
                   * successfully points at the new image.
                   */
                  if (
                    editing &&
                    previousStoragePath &&
                    (
                      newStoragePath ||
                      finalRemoveImage
                    )
                  ) {
                    const {
                      error:
                        cleanupError
                    } =
                      await supabase.storage
                        .from(
                          DISH_IMAGE_BUCKET
                        )
                        .remove([
                          previousStoragePath
                        ]);

                    if (
                      cleanupError
                    ) {
                      console.warn(
                        "Old dish image cleanup failed:",
                        cleanupError
                      );
                    }
                  }

                  showToast(
                    editing
                      ? "Dish updated"
                      : "Dish created",

                    payload.name
                  );

                  close();

                  await reload();

                } catch (
                  error
                ) {
                  /*
                   * If the new image was uploaded but the DB save failed,
                   * remove the new object so Storage never fills with orphans.
                   */
                  if (
                    newStoragePath
                  ) {
                    try {
                      await supabase.storage
                        .from(
                          DISH_IMAGE_BUCKET
                        )
                        .remove([
                          newStoragePath
                        ]);
                    } catch (
                      cleanupError
                    ) {
                      console.warn(
                        "Failed to remove orphaned upload:",
                        cleanupError
                      );
                    }
                  }

                  statusNode.innerHTML = `
                    <i class="ph ph-warning-circle"></i>
                    <span>
                      ${escapeHtml(
                        error.message
                      )}
                    </span>
                  `;

                  button.disabled =
                    false;

                  showToast(
                    "Could not save dish",
                    error.message,
                    "error"
                  );
                }
              }
          }
        ]
      });

    const fileInput =
      modal.root.querySelector(
        "#product-image"
      );

    const preview =
      modal.root.querySelector(
        "#image-preview"
      );

    const status =
      modal.root.querySelector(
        "#image-upload-status"
      );

    const removeImage =
      modal.root.querySelector(
        "#remove-image"
      );

    let previewUrl =
      null;

    fileInput?.addEventListener(
      "change",
      event => {
        const file =
          event.target.files?.[0];

        if (!file) {
          return;
        }

        if (
          file.size >
          MAX_SOURCE_IMAGE_BYTES
        ) {
          fileInput.value = "";

          showToast(
            "Image too large",
            "Please choose an image smaller than 12 MB.",
            "error"
          );

          return;
        }

        if (
          !file.type.startsWith(
            "image/"
          )
        ) {
          fileInput.value = "";

          showToast(
            "Invalid image",
            "Please select an image file.",
            "error"
          );

          return;
        }

        if (
          removeImage
        ) {
          removeImage.checked =
            false;
        }

        if (
          previewUrl
        ) {
          URL.revokeObjectURL(
            previewUrl
          );
        }

        previewUrl =
          URL.createObjectURL(
            file
          );

        preview.classList.remove(
          "empty"
        );

        preview.innerHTML = `
          <img
            src="${previewUrl}"
            alt=""
          />

          <div class="image-preview-copy">
            <strong>
              New image selected
            </strong>

            <span>
              ${escapeHtml(file.name)}
              ·
              ${(file.size / 1024 / 1024).toFixed(2)}
              MB source
            </span>
          </div>
        `;

        status.innerHTML = `
          <i class="ph ph-check-circle"></i>
          <span>
            Ready. It will be cropped to 4:3 and converted to optimized WebP when saved.
          </span>
        `;
      }
    );
  }

  // Listen for the custom inbox event triggered by navigation.js
  const adminAlertHandler = async () => {
    // Await reload() to fetch the live active tables without manual refresh.
    // The 400ms timeout ensures Postgres has completely finished saving the new session before we query it.
    setTimeout(async () => {
       if (section === "overview") await reload();
    }, 400);
  };
  window.addEventListener("ff_admin_alert_received", adminAlertHandler);

  // --- LIVE MONITORING WEBSOCKET ---
  const realtimeChannel = supabase.channel('admin-live-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, async payload => {
      if (section === "orders") renderOrders();
      else if (section === "overview") await reload();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'dining_sessions' }, async payload => {
      // CUSTOMER AUTO-CLOSE DETECTION: 
      // If status jumps directly from 'open' to 'closed', the customer generated the bill!
      if (payload.new?.status === "closed" && payload.old?.status === "open") {
        showToast("Bill Generated & Table Freed!", `A customer finished their meal. Check the Orders tab for their bill.`, "success");
        
        // Highlight the Orders tab in Gold to notify the admin
        const ordersNavBtn = mount.querySelector('[data-section="orders"]');
        if (ordersNavBtn) {
          ordersNavBtn.style.color = "var(--gold-600)";
          ordersNavBtn.classList.remove("qty-pulse");
          void ordersNavBtn.offsetWidth;
          ordersNavBtn.classList.add("qty-pulse");
        }
      } else if (payload.new?.status === "closed" && payload.old?.status !== "closed") {
        showToast("Table Closed", "A table session was finalized by staff.");
      }
      
      if (section === "overview" || section === "tables") await reload();
    })
    .subscribe();

  renderSection();
  
  // Cleanup the socket connection if the admin logs out or closes the workspace
  return () => {
    navCleanup?.();
    window.removeEventListener("ff_admin_alert_received", adminAlertHandler);
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  };
}

function metricCard(icon, value, label) {
  return `<article class="metric-card"><div class="metric-icon"><i class="ph ${icon}"></i></div><strong>${Number(value || 0)}</strong><span>${escapeHtml(label)}</span></article>`;
}
