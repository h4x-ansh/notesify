/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/template.js"],
  // Utility classes only referenced indirectly via string interpolation
  // (e.g. CALLOUT_STYLE values) — listed explicitly since Tailwind's
  // static analysis can miss classes assembled through object lookups.
  safelist: [
    "bg-yellow-100/60",
    "bg-red-50/50",
    "bg-blue-50/50",
    "bg-rose-50",
    "bg-emerald-50/50",
    "border-yellow-500",
    "border-red-500",
    "border-blue-400",
    "border-red-400",
    "border-emerald-400",
    "bg-amber-600",
    "bg-rose-600",
    "bg-blue-600",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
