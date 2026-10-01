/**
 * Client-side order/cart state. Money uses integer paise internally.
 * PostgreSQL remains the authority for actual prices and taxes.
 */
const PAISA = 100;
const toPaise = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * PAISA) : 0;
const fromPaise = value => Math.round(value) / PAISA;
const qty = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1000, Math.round(Number(value)))) : 0;

export function calculateTotals(items, settings = {}) {
  const cgstRate = Math.max(0, Number(settings.cgst_rate) || 0);
  const sgstRate = Math.max(0, Number(settings.sgst_rate) || 0);
  let subtotalPaise = 0;
  let taxablePaise = 0;

  for (const item of items) {
    const line = toPaise(item.price) * qty(item.quantity);
    subtotalPaise += line;
    if (!item.tax_exempt) taxablePaise += line;
  }

  const cgstPaise = Math.round(taxablePaise * cgstRate / 100);
  const sgstPaise = Math.round(taxablePaise * sgstRate / 100);
  const preRoundPaise = subtotalPaise + cgstPaise + sgstPaise;
  const grandPaise = Math.round(preRoundPaise / PAISA) * PAISA;

  return {
    subtotal: fromPaise(subtotalPaise),
    cgst: fromPaise(cgstPaise),
    sgst: fromPaise(sgstPaise),
    rounding: fromPaise(grandPaise - preRoundPaise),
    grandTotal: fromPaise(grandPaise),
    cgstRate,
    sgstRate
  };
}

export function createPOSState(initial = {}) {
  let orderType = initial.orderType ?? "dine_in";
  let tableId = initial.tableId ?? null;
  let settings = { cgst_rate: 2.5, sgst_rate: 2.5, ...(initial.settings ?? {}) };
  const cart = new Map();
  const listeners = new Set();

  const snapshot = () => {
    const items = [...cart.values()].map(item => ({ ...item }));
    return { items, orderType, tableId, totals: calculateTotals(items, settings) };
  };
  const emit = () => listeners.forEach(listener => listener(snapshot()));

  return {
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    getState() { return snapshot(); },
    setSettings(next) { settings = { ...settings, ...(next ?? {}) }; emit(); },
    setOrderType(next) {
      orderType = next === "takeaway" ? "takeaway" : "dine_in";
      if (orderType === "takeaway") tableId = null;
      emit();
    },
    setTable(table) { tableId = table?.id ?? null; emit(); },
    addProduct(product) {
      if (!product?.id) return;
      const current = cart.get(product.id);
      cart.set(product.id, {
        id: product.id,
        name: product.name,
        category: product.category ?? "Uncategorized",
        price: Number(product.price) || 0,
        tax_exempt: Boolean(product.tax_exempt),
        quantity: qty((current?.quantity ?? 0) + 1)
      });
      emit();
    },
    increment(id) { const item = cart.get(id); if (!item) return; item.quantity = qty(item.quantity + 1); cart.set(id, item); emit(); },
    decrement(id) {
      const item = cart.get(id); if (!item) return;
      item.quantity = qty(item.quantity - 1);
      if (item.quantity <= 0) cart.delete(id); else cart.set(id, item);
      emit();
    },
    remove(id) { cart.delete(id); emit(); },
    clear() { cart.clear(); emit(); },
    canSubmit() {
      const value = snapshot();
      return value.items.length > 0 && (value.orderType === "takeaway" || Boolean(value.tableId));
    },
    toServerItems() { return snapshot().items.map(item => ({ product_id: item.id, quantity: item.quantity })); }
  };
}
