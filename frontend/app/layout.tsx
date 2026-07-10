import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
