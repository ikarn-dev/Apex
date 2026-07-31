"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { XpPill } from "@/components/layout/XpPill";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/campaign", label: "Campaign" },
  { href: "/garage", label: "Garage" },
  { href: "/settings", label: "Settings" },
] as const;

/**
 * Shared shape for a nav item.
 *
 * `clip-notch` is the same corner cut the connect button wears — it comes from
 * `Button`'s base class — so a hovered or active tab is cut from the same die as the
 * primary control in the header rather than being a differently-shaped highlight
 * sitting next to it.
 *
 * Hover fills quietly; active fills in gold, which is the palette's one accent and
 * already means "this is the live thing" on the campaign cards.
 */
const ITEM =
  "clip-notch inline-flex items-center font-ui font-semibold uppercase transition-colors duration-150";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="safe-t sticky top-0 z-40 border-b grid-rule bg-ink/85 backdrop-blur-md">
        <div className="flex h-16 w-full items-center gap-4 px-4 sm:gap-8 sm:px-8">
          <Link
            href="/"
            className="shrink-0 font-display text-2xl font-extrabold leading-none tracking-tight text-cream transition-colors hover:text-gold"
          >
            APEX
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    ITEM,
                    "h-9 px-4 text-[13px] tracking-[0.12em]",
                    active
                      ? "bg-gold text-navy"
                      : "text-cream/55 hover:bg-cream/10 hover:text-cream",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <XpPill className="hidden sm:flex" />
            <ConnectButton size="sm" />
          </div>
        </div>
      </header>

      <main className="safe-x flex-1">{children}</main>

      {/* Mobile nav: a bottom bar, because a hamburger menu for three links is two
          taps where one will do. */}
      <nav
        className="safe-b sticky bottom-0 z-40 border-t grid-rule bg-ink/95 backdrop-blur-md md:hidden"
        aria-label="Main"
      >
        <div className="flex items-center justify-around gap-1 px-2 py-2">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  ITEM,
                  "h-10 flex-1 justify-center text-[12px] tracking-[0.1em]",
                  active ? "bg-gold text-navy" : "text-cream/55",
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
