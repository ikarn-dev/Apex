import type { Metadata, Viewport } from "next";
import { Chakra_Petch, JetBrains_Mono } from "next/font/google";
import { AppProviders } from "@/components/providers/AppProviders";
import "./globals.css";

const display = Chakra_Petch({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-display",
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
  themeColor: "#05070a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
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
