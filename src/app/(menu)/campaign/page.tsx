import type { Metadata } from "next";
import { CampaignScreen } from "@/components/screens/CampaignScreen";
import { circuitOutlinePath } from "@/game/track/outline";

export const metadata: Metadata = {
  title: "Campaign",
  description:
    "Two acts, each teaching one part of the MagicBlock Ephemeral Rollup lifecycle through a racing mechanic. A third is in development.",
};

export default function CampaignPage() {
  // Built here, on the server: the shape is a pure function of the authored route,
  // so it costs the browser nothing but the path string.
  return <CampaignScreen outline={circuitOutlinePath()} />;
}
