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
  let section = "overview";

  mount.innerHTML = `
    <section class="admin-page">
      <header class="app-topbar admin-topbar">
        <div class="topbar-side topbar-left" style="gap: 12px;">
          <button class="icon-btn icon-btn-dark" id="admin-menu" title="Menu" aria-label="Menu"><i class="ph ph-list"></i></button>
          <img src="${versionedAsset("assets/images/website_logo.png")}" alt="Four Flavours" style="height: 40px; width: auto;" />
        </div>
        <div class="brand-center main-logo-only">
          <!-- Center logo safely removed to match POS layout -->
        </div>
        <div class="topbar-side topbar-right">
          <button class="icon-btn icon-btn-dark" id="admin-refresh" title="Refresh" aria-label="Refresh"><i class="ph ph-arrows-clockwise"></i></button>
        </div>
      </header>

      <nav class="admin-section-nav" id="admin-section-nav" aria-label="Management sections">
        <button data-section="overview" class="active"><i class="ph-bold ph-squares-four"></i><span>Overview</span></button>
        <button data-section="orders"><i class="ph-bold ph-receipt"></i><span>Orders</span></button>
        <button data-section="cuisines"><i class="ph-bold ph-image"></i><span>Cuisines</span></button>
        <button data-section="menu"><i class="ph-bold ph-fork-knife"></i><span>Menu</span></button>
        <button data-section="tables"><i class="ph-bold ph-armchair"></i><span>Tables</span></button>
        <button data-section="settings"><i class="ph-bold ph-gear"></i><span>Settings</span></button>
      </nav>
      <main class="admin-content"><section id="admin-area"></section></main>
    </section>`;

  const navCleanup = mountNavigation({ active: "admin" });
  const area = mount.querySelector("#admin-area");

  mount.querySelector("#admin-menu").addEventListener("click", () => window.__FOUR_FLAVOURS_NAV__?.open());
  mount.querySelector("#admin-refresh").addEventListener("click", async () => { await reload(); showToast("Workspace refreshed"); });
  mount.querySelector("#admin-section-nav").addEventListener("click", event => {
    const b = event.target.closest("[data-section]");
    if (!b) return;
    section = b.dataset.section;
    mount.querySelectorAll("[data-section]").forEach(el => el.classList.toggle("active", el === b));
    renderSection();
  });

  async function reload() {
    ({ settings, products, tables, sessions, cuisines } = await fetchWorkspace());
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

      list.innerHTML = orders.map(o => `
        <article class="admin-product-row">
          <div class="admin-product-main">
            <div class="admin-product-title">
              <div><strong>Order #${escapeHtml(o.order_number)}</strong><span>${new Date(o.created_at).toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}</span></div>
              <strong>${money(o.grand_total, settings.currency_symbol)}</strong>
            </div>
            <p>${o.order_type === 'dine_in' ? `Dine-in · Table ${tables.find(t => t.id === o.table_id)?.table_no || 'Unknown'}` : 'Takeaway'} · ${o.order_items.length} items</p>
          </div>
          <div class="admin-product-actions">
            <button class="icon-btn icon-btn-light" data-view-order="${o.id}" title="View Receipt"><i class="ph ph-printer"></i></button>
            <button class="icon-btn icon-btn-danger" data-delete-order="${o.id}" title="Delete Order"><i class="ph ph-trash"></i></button>
          </div>
        </article>
      `).join("");

      list.addEventListener("click", e => {
        const view = e.target.closest("[data-view-order]");
        const del = e.target.closest("[data-delete-order]");
        if (view) showAdminReceiptPreview(orders.find(x => x.id === view.dataset.viewOrder));
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
      const qr = modal.root.querySelector("#admin-thermal-upi"); 
      const url = new URL("upi://pay"); 
      url.searchParams.set("pa", settings.upi_id); 
      url.searchParams.set("pn", settings.restaurant_name); 
      url.searchParams.set("am", Number(order.grand_total).toFixed(2)); 
      url.searchParams.set("cu", "INR"); 
      url.searchParams.set("tn", `Order #${order.order_number}`);
      new QRCode(qr, { text: url.toString(), width: 140, height: 140, correctLevel: QRCode.CorrectLevel.L });
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
    area.innerHTML = `
      <section class="admin-hero"><div><span class="eyebrow">Control centre</span><h1>Everything in its place.</h1><p>Menu, tables, tax, UPI and table sessions in one restrained workspace.</p></div><div class="admin-hero-mark"><img src="${versionedAsset("assets/images/website_icon.png")}" alt=""></div></section>
      <section class="metric-grid">${metricCard("ph-fork-knife", activeProducts, "Active dishes")}${metricCard("ph-armchair", activeTables, "Active tables")}${metricCard("ph-bell", sessions.length, "Open sessions")}${metricCard("ph-receipt", billRequests, "Bill requests")}</section>
      <section class="admin-grid-two">
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Quick actions</span><h2>Run the floor</h2></div></div><div class="quick-action-grid"><button class="quick-action" data-go="tables"><i class="ph ph-armchair"></i><span><strong>Manage tables</strong><small>Add, edit, delete and print QR codes.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="menu"><i class="ph ph-fork-knife"></i><span><strong>Manage menu</strong><small>Names, descriptions, prices and visibility.</small></span><i class="ph ph-arrow-right"></i></button><button class="quick-action" data-go="settings"><i class="ph ph-gear"></i><span><strong>Tax & UPI</strong><small>Keep server-side billing settings current.</small></span><i class="ph ph-arrow-right"></i></button></div></article>
        <article class="admin-panel"><div class="panel-head"><div><span class="eyebrow">Dining sessions</span><h2>Open tables</h2></div><span class="soft-badge">${sessions.length} active</span></div><div class="session-mini-scroll">${sessions.length ? sessions.map(s => `<div class="admin-mini-row"><div class="mini-row-icon"><i class="ph ph-armchair"></i></div><div><strong>Table ${escapeHtml(tables.find(t => t.id === s.table_id)?.table_no ?? "—")}</strong><span>${s.status === "bill_requested" ? "Bill requested" : s.status === "bill_ready" ? "Bill ready" : "Dining session open"}</span></div><span class="session-status ${s.status}">${s.status === "bill_requested" ? "Action" : s.status === "bill_ready" ? "Ready" : "Open"}</span></div>`).join("") : `<div class="empty-state compact"><i class="ph ph-circle-wavy-check"></i><strong>No open table sessions</strong><span>The floor is currently clear.</span></div>`}</div></article>
      </section>`;
    area.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => { section = b.dataset.go; mount.querySelectorAll("[data-section]").forEach(el => el.classList.toggle("active", el.dataset.section === section)); renderSection(); }));
  }

  function renderMenu() {
    area.innerHTML = `
      <section class="section-title-row"><div><span class="eyebrow">Menu management</span><h1>Every dish, neatly managed.</h1><p>Long lists stay inside a contained vertical workspace instead of stretching the entire page.</p></div><button class="btn btn-primary" id="add-product"><i class="ph-bold ph-plus"></i>Add dish</button></section>
      <section class="admin-panel"><div class="panel-toolbar"><div class="search-wrap light"><i class="ph ph-magnifying-glass"></i><input class="search-input" id="product-search" type="search" placeholder="Search dishes or categories"></div><span class="soft-badge">${products.length} dishes</span></div><div class="admin-list-scroll" id="product-list"></div></section>`;
    const search = area.querySelector("#product-search");
    const list = area.querySelector("#product-list");
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const visible = products.filter(p => !q || `${p.name} ${p.category} ${p.description ?? ""}`.toLowerCase().includes(q));
      list.innerHTML = visible.length ? visible.map(product => `<article class="admin-product-row"><div class="admin-product-image">${product.image_url ? `<img src="${versionedAsset(product.image_url)}" alt="" loading="lazy">` : `<div class="product-placeholder"><i class="ph ph-fork-knife"></i></div>`}</div><div class="admin-product-main"><div class="admin-product-title"><div><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)}</span></div><strong>${money(product.price)}</strong></div><p>${escapeHtml(product.description ?? "")}</p></div><div class="admin-product-actions"><span class="active-badge ${product.is_active ? "active" : ""}"><span></span>${product.is_active ? "Live" : "Hidden"}</span><button class="icon-btn icon-btn-light" data-edit-product="${product.id}" title="Edit dish" aria-label="Edit dish"><i class="ph ph-pencil-simple"></i></button></div></article>`).join("") : `<div class="empty-state"><i class="ph ph-magnifying-glass"></i><strong>No dishes found</strong><span>Try another search.</span></div>`;
    };
    search.addEventListener("input", paint); paint();
    area.querySelector("#add-product").addEventListener("click", () => openProductEditor());
    list.addEventListener("click", e => { const b = e.target.closest("[data-edit-product]"); if (!b) return; const p = products.find(x => x.id === b.dataset.editProduct); if (p) openProductEditor(p); });
  }

  function renderTables() {
    area.innerHTML = `
      <section class="section-title-row"><div><span class="eyebrow">Floor layout</span><h1>Tables without clutter.</h1><p>Manage table numbers, capacity, visibility and QR codes with custom in-site forms.</p></div><button class="btn btn-primary" id="add-table"><i class="ph-bold ph-plus"></i>Add table</button></section>
      <section class="admin-panel"><div class="panel-toolbar"><span class="soft-badge">${tables.length} tables</span><span class="panel-help">
  <i class="ph ph-qr-code"></i>
  Production QR · tff.vercel.app · table ID
</span></div><div class="admin-table-scroll" id="table-list"></div></section>`;
    const list = area.querySelector("#table-list");
    list.innerHTML = tables.length ? tables.map(t => `<article class="table-admin-card ${t.is_active ? "" : "inactive"}"><div class="table-badge"><i class="ph-bold ph-armchair"></i><strong>${escapeHtml(t.table_no)}</strong></div><div class="table-card-main"><div><span class="eyebrow">Table ${escapeHtml(t.table_no)}</span><strong>${Number(t.capacity)} ${Number(t.capacity) === 1 ? "seat" : "seats"}</strong></div><span class="table-state ${t.is_active ? "active" : "inactive"}"><span></span>${t.is_active ? "Active" : "Hidden"}</span></div><div class="table-card-actions">${t.is_active ? `<button class="icon-btn icon-btn-light" data-qr="${t.id}" title="Table QR" aria-label="Table QR"><i class="ph-bold ph-qr-code"></i></button>` : ""}<button class="icon-btn icon-btn-light" data-edit-table="${t.id}" title="Edit table" aria-label="Edit table"><i class="ph-bold ph-pencil-simple"></i></button><button class="icon-btn icon-btn-danger" data-delete-table="${t.id}" title="Delete table" aria-label="Delete table"><i class="ph-bold ph-trash"></i></button></div></article>`).join("") : `<div class="empty-state"><i class="ph-bold ph-armchair"></i><strong>No tables yet</strong><span>Create the first table to generate a QR.</span></div>`;
    area.querySelector("#add-table").addEventListener("click", () => openTableEditor());
    list.addEventListener("click", e => {
      const edit = e.target.closest("[data-edit-table]");
      const del = e.target.closest("[data-delete-table]");
      const qr = e.target.closest("[data-qr]");
      if (edit) { const t = tables.find(x => x.id === edit.dataset.editTable); if (t) openTableEditor(t); }
      if (del) { const t = tables.find(x => x.id === del.dataset.deleteTable); if (t) openTableDelete(t); }
      if (qr) { const t = tables.find(x => x.id === qr.dataset.qr); if (t) openTableQR(t); }
    });
  }

  function renderSettings() {
    area.innerHTML = `<section class="section-title-row"><div><span class="eyebrow">Restaurant settings</span><h1>Keep the bill precise.</h1><p>The final tax and total are calculated on the database, not trusted from the browser.</p></div></section><section class="admin-panel settings-panel"><form id="settings-form" class="settings-form-grid"><label class="field"><span>Restaurant name</span><input class="field-input" name="restaurant_name" value="${escapeHtml(settings.restaurant_name)}" required></label><label class="field"><span>UPI ID</span><input class="field-input" name="upi_id" value="${escapeHtml(settings.upi_id || "")}" placeholder="fourflavours@upi"></label><label class="field"><span>GSTIN (GST Number)</span><input class="field-input" name="gst_number" value="${escapeHtml(settings.gst_number || "")}" placeholder="22AAAAA0000A1Z5"></label><label class="field settings-wide"><span>Restaurant Address (Prints on Bill)</span><textarea class="field-input textarea-input" name="restaurant_address" placeholder="123 Food Street, City, State" rows="2">${escapeHtml(settings.restaurant_address || "")}</textarea></label><label class="field"><span>CGST %</span><input class="field-input" name="cgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.cgst_rate)}" required></label><label class="field"><span>SGST %</span><input class="field-input" name="sgst_rate" type="number" min="0" max="100" step="0.01" value="${Number(settings.sgst_rate)}" required></label><label class="field settings-wide"><span>Receipt footer</span><input class="field-input" name="receipt_footer" value="${escapeHtml(settings.receipt_footer || "")}"></label><div class="settings-wide settings-preview"><div class="settings-preview-icon"><i class="ph ph-shield-check"></i></div><div><strong>Secure calculation</strong><span>Prices, tax rates and the final total are recalculated by PostgreSQL when the order is created.</span></div></div><div class="settings-wide"><button class="btn btn-primary" type="submit"><i class="ph ph-floppy-disk"></i>Save settings</button></div></form></section>`;
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
      subtitle: "This QR always opens the live Four Flavours menu at tff.vercel.app.",
      body: `<div class="qr-preview-panel"><div class="qr-preview" id="table-qr"></div><div class="qr-table-title">Table ${escapeHtml(table.table_no)}</div><div class="qr-url">${escapeHtml(url)}</div><div class="qr-safety-note">
  <i class="ph ph-shield-check"></i>
  <span>
    Production QR · Opens only the Four Flavours customer menu for this table.
  </span>
</div></div>`,
      actions: [
        { label: "Close", icon: "ph-x", className: "btn-quiet", onClick: ({ close }) => close() },
        { label: "Print QR", icon: "ph-printer", className: "btn-primary", onClick: ({ button }) => { button.disabled = true; const host = document.querySelector("#qr-print-host"); const qr = modal.root.querySelector("#table-qr"); host.innerHTML = `<section class="qr-print-sheet"><img src="${versionedAsset("assets/images/website_icon.png")}" alt=""><h1>Four Flavours</h1><h2>Table ${escapeHtml(table.table_no)}</h2><div class="qr-print-code">${qr.innerHTML}</div><p>Scan to view the menu & order</p></section>`; document.body.classList.add("print-qr"); window.print(); setTimeout(() => { document.body.classList.remove("print-qr"); host.innerHTML = ""; button.disabled = false; }, 800); } }
      ]
    });
    if (globalThis.QRCode) new QRCode(modal.root.querySelector("#table-qr"), { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
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

  // --- LIVE MONITORING WEBSOCKET ---
  const realtimeChannel = supabase.channel('admin-live-updates')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, payload => {
      // 1. Alert the staff instantly
      showToast("New Order Received", `Order #${payload.new.order_number} has been confirmed.`);
      
      // 2. Silently update the UI based on what the admin is currently viewing
      if (section === "orders") {
        renderOrders();
      } else if (section === "overview") {
        reload();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dining_sessions' }, () => {
      // Live update the table statuses on the Overview dashboard
      if (section === "overview") reload();
    })
    .subscribe();

  renderSection();
  
  // Cleanup the socket connection if the admin logs out or closes the workspace
  return () => {
    navCleanup?.();
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  };
}

function metricCard(icon, value, label) {
  return `<article class="metric-card"><div class="metric-icon"><i class="ph ${icon}"></i></div><strong>${Number(value || 0)}</strong><span>${escapeHtml(label)}</span></article>`;
}
