import type { Metadata, Viewport } from "next";
import { Inter, Kalam } from "next/font/google";
import "./globals.css";

// Inter for UI chrome (buttons, labels, body text - everywhere) - Kalam
// (the same handwriting font the generated-notes PDF template uses) only
// for the app name/headers, deliberately sparing rather than applied
// wholesale - see AppShell.module.css's use of var(--font-hand). Both
// self-hosted via next/font (downloaded at build time, served locally -
// no runtime request to Google Fonts, unlike the PDF template's own
// <link> tags, which run inside a one-shot Puppeteer page rather than the
// long-lived app shell).
const interFont = Inter({ subsets: ["latin"], variable: "--next-font-ui", display: "swap" });
const kalamFont = Kalam({ subsets: ["latin"], weight: ["400", "700"], variable: "--next-font-hand", display: "swap" });

export const metadata: Metadata = {
  title: "Notesify — hisarchives",
  description: "YouTube lecture to handwritten topper's-notebook style PDF notes.",
};

// Explicit rather than relying on Next's default - matters for the
// Capacitor/Android build specifically, where this renders inside a native
// WebView rather than a normal mobile browser tab. viewportFit "cover" and
// maximumScale 1 keep the layout from being pushed around by on-screen
// keyboards / notches in that context.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${interFont.variable} ${kalamFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
