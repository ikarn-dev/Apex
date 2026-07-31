"use client";

/**
 * Client boundary for the car viewer.
 *
 * The viewer pulls three.js and the GLTF loader, so it is loaded with `ssr: false`
 * to keep both out of the server render and out of every other route's first load.
 * `next/dynamic` cannot do that from inside a server component, which is the only
 * reason this wrapper exists — the landing page is a server component.
 *
 * Takes a `CarId` rather than a `CarDefinition` so a server component does not have
 * to serialise a config object across the boundary to name one car.
 */

import dynamic from "next/dynamic";
import { CARS, type CarId } from "@/game/config/cars";

const CarViewer = dynamic(() => import("./CarViewer").then((m) => m.CarViewer), {
  ssr: false,
});

export function CarStage({
  carId,
  className,
  spin,
}: {
  carId: CarId;
  className?: string;
  spin?: boolean;
}) {
  return <CarViewer car={CARS[carId]} className={className} spin={spin} />;
}
