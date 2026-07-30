import type { Metadata } from "next";
import { ProfileGate } from "@/components/screens/ProfileGate";

export const metadata: Metadata = {
  title: "Profile",
  description: "Rank, settled XP, unsettled runs and best times.",
};

export default function ProfilePage() {
  return <ProfileGate />;
}
