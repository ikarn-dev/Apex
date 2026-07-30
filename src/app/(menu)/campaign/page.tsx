import type { Metadata } from "next";
import { CampaignScreen } from "@/components/screens/CampaignScreen";

export const metadata: Metadata = {
  title: "Campaign",
  description:
    "Five acts, each teaching one part of the MagicBlock Ephemeral Rollup lifecycle through a racing mechanic.",
};

export default function CampaignPage() {
  return <CampaignScreen />;
}
