import { AppShell } from "@/components/layout/AppShell";

/**
 * Menu chrome for everything except the race route.
 *
 * A route group rather than a conditional inside one layout, so the race view
 * never mounts navigation it would only have to hide.
 */
export default function MenuLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
