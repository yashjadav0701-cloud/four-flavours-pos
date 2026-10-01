import { APP_VERSION } from "./src/core/config.js";
import { startRouter } from "./src/core/router.js";

window.FourFlavours = Object.freeze({ name: "Four Flavours", APP_VERSION, build: APP_VERSION });
const mount = document.querySelector("#app");
if (!mount) throw new Error("Four Flavours root #app was not found.");
startRouter({ mount });
