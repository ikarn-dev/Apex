import type { Metadata } from "next";
import { SettingsScreen } from "@/components/screens/SettingsScreen";

export const metadata: Metadata = {
  title: "Settings",
  description: "Control scheme, audio and camera.",
};

export default function SettingsPage() {
  return <SettingsScreen />;
}
