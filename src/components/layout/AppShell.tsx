"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { XpPill } from "@/components/layout/XpPill";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/campaign", label: "Campaign" },
  { href: "/garage", label: "Garage" },
  { href: "/profile", label: "Profile" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * Menu chrome.
 *
 * Applied by the `(menu)` route group only — the race route deliberately has no
 * navigation, because a persistent header over a 3D scene costs both pixels and
 * attention.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="safe-t sticky top-0 z-40 border-b border-steel bg-void/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link
            href="/"
            className="group flex shrink-0 items-baseline gap-2"
            aria-label="APEX home"
          >
            <span className="font-display text-xl font-bold tracking-tight text-chalk transition-colors group-hover:text-apex">
              APEX
            </span>
            <span className="hidden text-[10px] uppercase tracking-[0.22em] text-fog sm:inline">
              Zero Latency
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="ml-6 hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors",
                    active ? "text-apex" : "text-fog hover:text-chalk",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <XpPill />
            <ConnectButton size="sm" />
          </div>
        </div>
      </header>

      <main className="safe-x flex-1">{children}</main>

      {/* Mobile nav: a bottom bar, because a hamburger menu for four links is
          two taps where one will do. */}
      <nav
        className="safe-b sticky bottom-0 z-40 border-t border-steel bg-void/95 backdrop-blur-md md:hidden"
        aria-label="Main"
      >
        <div className="grid grid-cols-4">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-14 items-center justify-center font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
                  active ? "text-apex" : "text-fog",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
