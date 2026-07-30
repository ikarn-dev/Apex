import type { Metadata } from "next";
import { SettingsScreen } from "@/components/screens/SettingsScreen";

export const metadata: Metadata = {
  title: "Settings",
  description: "Graphics tiers, control schemes, audio and chain endpoints.",
};

export default function SettingsPage() {
  return <SettingsScreen />;
}
