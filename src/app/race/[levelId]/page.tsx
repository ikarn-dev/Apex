import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RaceLoader } from "@/components/race/RaceLoader";
import { LEVEL_IDS, LEVELS, getLevel } from "@/game/config/levels";

/** The campaign is fixed, so every race route can be prerendered. */
export function generateStaticParams() {
  return LEVEL_IDS.map((levelId) => ({ levelId }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ levelId: string }>;
}): Promise<Metadata> {
  const { levelId } = await params;
  const level = getLevel(levelId);
  if (!level) return { title: "Race" };
  return {
    title: `${level.actLabel} · ${level.title}`,
    description: level.conceptDetail,
  };
}

export default async function RacePage({
  params,
}: {
  params: Promise<{ levelId: string }>;
}) {
  const { levelId } = await params;
  const level = getLevel(levelId);
  if (!level) notFound();

  // Passed as a plain object across the server/client boundary: the level config
  // is serialisable data, so the client bundle does not need to look it up.
  return <RaceLoader level={LEVELS[level.id]} />;
}
