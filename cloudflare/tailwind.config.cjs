// Utilities for the pages built from the UX Pilot SecureEntry designs (the designs use Tailwind classes).
// `important: ".se"` scopes them under an element with class "se", so they win over the older style.css
// on pages that still use it. Preflight is built separately (tailwind.base.config.cjs).
module.exports = {
  content: ["./src/**/*.ts"],
  important: ".se",
  corePlugins: { preflight: false },
  theme: { extend: {} },
};
