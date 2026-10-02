// --- UNIFIED ARCHITECTURE MIRROR ---
// This file now acts as a pure passthrough. 
// When the router detects a table URL, it routes here, and we seamlessly 
// hand off the rendering to the master POS engine to ensure 100% parity.

import { render as renderPOS } from "../pos/index.js";

export async function render(context) {
  // Pass the mount point directly into the POS engine
  return await renderPOS(context);
}