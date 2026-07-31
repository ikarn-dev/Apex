import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono, Rajdhani } from "next/font/google";
import { AppProviders } from "@/components/providers/AppProviders";
import "./globals.css";

/**
 * Three faces, each with one job.
 *
 * `Archivo` carries display type and prose. It is a wide grotesque with a real 900,
 * which is what an oversized wordmark needs, and it still sets a readable paragraph —
 * so it replaces Manrope rather than sitting alongside it. One fewer download.
 *
 * `Rajdhani` is the interface face: navigation, buttons, badges, labels. It was drawn
 * for screen UI, is squarish and technical without tipping into sci-fi pastiche, and
 * holds up at the small uppercase sizes this chrome is set in — which is exactly
 * where a grotesque goes muddy.
 *
 * `JetBrains Mono` is for numbers only. Lap times, XP and telemetry have to line up
 * in columns; nothing else needs a monospace.
 */
const display = Archivo({
  weight: ["500", "600", "700", "800", "900"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const ui = Rajdhani({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

const mono = JetBrains_Mono({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "APEX: Zero Latency",
    template: "%s · APEX",
  },
  description:
    "An arcade street racer that settles on Solana. Race inside a MagicBlock Ephemeral Rollup at 10ms, then commit your run on-chain.",
  applicationName: "APEX",
  keywords: ["racing game", "solana", "magicblock", "ephemeral rollups", "web3 game"],
  openGraph: {
    title: "APEX: Zero Latency",
    description:
      "Race in an Ephemeral Session. Commit your run to Solana. Speed is free, permanence is not.",
    type: "website",
  },
  appleWebApp: {
    capable: true,
    title: "APEX",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The race view is a fixed-size canvas; pinch-zooming it only breaks aim.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#091426",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${ui.variable} ${mono.variable}`}
    >
      {/*
        `suppressHydrationWarning` covers exactly one real case: browser extensions
        stamp attributes onto <body> before React hydrates — `bis_register` and
        `__processed_<uuid>__` from anti-tracking extensions are the common ones —
        and React reports the resulting attribute diff as a hydration mismatch the
        app cannot fix. This flag applies to this element's own attributes only, not
        to its children, so a genuine mismatch inside the app is still reported.
      */}
      <body className="antialiased" suppressHydrationWarning>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
