import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Q Terminal",
  description: "Crypto market terminal",
  appleWebApp: { capable: true, title: "Q Terminal", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};
// viewportFit cover lets the layout run under the notch and home bar; the CSS keeps content inside the safe areas.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body>{children}</body>
    </html>
  );
}
