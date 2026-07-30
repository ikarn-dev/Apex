import type { Metadata } from "next";
import { GarageScreen } from "@/components/screens/GarageScreen";

export const metadata: Metadata = {
  title: "Garage",
  description: "Three cars with genuinely different physics. Unlocked with settled XP.",
};

export default function GaragePage() {
  return <GarageScreen />;
}
