"use client";

/**
 * Turntable view of a car, for the garage.
 *
 * This is the real race model, loaded through the same `Resources.prepareCar` the
 * engine uses, so what the garage shows is what you drive — same geometry, same
 * scale, same materials. A render or a marketing shot would drift from the car the
 * moment the asset pipeline ran again.
 *
 * Two things are not optional here:
 *
 * **An environment map.** The bodywork is metallic, and a metallic surface with
 * nothing to reflect renders near-black however bright the lights are. Ten lines of
 * pre-filtered gradient is the difference between a car and a silhouette.
 *
 * **Full teardown.** This mounts on a menu route the player walks in and out of, so
 * the context, the geometry and the textures all have to go back. A leaked
 * `WebGLRenderer` per visit exhausts the browser's context limit in a handful of
 * navigations.
 *
 * Loaded through `next/dynamic` by the garage: three.js is ~150KB and the rest of
 * the menu has no use for it.
 */

import { useEffect, useRef, useState } from "react";
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Box3,
  BufferAttribute,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import type { CarDefinition } from "@/game/config/cars";
import { Resources } from "@/game/engine/Resources";
import { cn } from "@/lib/cn";

/**
 * Camera placement. Radians.
 *
 * Front three-quarter with the car pointing to the right of frame, camera almost
 * down at wheel height looking very slightly up. A high angle looks down onto the
 * roof, which is the one view that flattens a low car.
 *
 * The sign of `AZIMUTH` is what decides which way the car faces, and it is not
 * obvious: `lookAt` builds screen-right as `cross(worldUp, direction)`, which works
 * out to `(dz, 0, -dx)`. The model's nose is +Z, so it lands on the right of frame
 * only while `dx` is negative — that is, at a *negative* azimuth. Positive put the
 * car nose-left, mirrored from the intended pose.
 *
 * The magnitude sets how square-on it is. 40° shows the whole front and a flank;
 * the 60° it was at had gone nearly full profile.
 */
const AZIMUTH = -0.7;
const ELEVATION = 0.05;
/**
 * Breathing room around the fitted car. 1.0 is an exact fit to the canvas.
 *
 * The camera distance is *solved* rather than guessed — see `fitCamera`. The old
 * approach put it at `longest dimension × 1.45`, which ignores the canvas shape
 * entirely: on a wide hero canvas that framed the car to about a third of the
 * available height and left the large empty bands above and below it.
 */
const FRAMING = 1.08;

/**
 * How far down the frame the car sits, as a fraction of the spare vertical room.
 *
 * A low wide car in a wide canvas cannot fill the height — the width runs out first,
 * so there is always vertical slack. Centring the car splits that slack evenly and
 * leaves a band of nothing under it. Pushing the car most of the way down moves all
 * of that room to the top, which is where the wordmark is and where it is wanted.
 *
 * 0 centres, 1 puts the sills on the bottom edge. Sitting a little under centre
 * leaves a band of clear space beneath the car, so it reads as sitting in the frame
 * rather than resting on the copy below it.
 */
const LOW_IN_FRAME = 0.2;
/** Turntable speed, radians per second. */
const SPIN = 0.22;

/** Sky gradient for the reflection probe, matching the desert dusk of the circuit. */
const HORIZON = 0xffc98d;
const ZENITH = 0x2a3550;

function buildEnvironment(
  renderer: WebGLRenderer,
): { texture: Texture; dispose: () => void } {
  const pmrem = new PMREMGenerator(renderer);
  const source = new Scene();

  const geometry = new SphereGeometry(40, 24, 16);
  const top = new Color(ZENITH);
  const bottom = new Color(HORIZON);
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const mixed = new Color();
  for (let i = 0; i < position.count; i += 1) {
    // Normalised height over the sphere, so the gradient runs floor to ceiling.
    const t = position.getY(i) / 40 * 0.5 + 0.5;
    mixed.copy(bottom).lerp(top, t);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));

  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    toneMapped: false,
  });
  const dome = new Mesh(geometry, material);
  source.add(dome);

  const target = pmrem.fromScene(source);
  geometry.dispose();
  material.dispose();
  pmrem.dispose();
  source.clear();

  return { texture: target.texture, dispose: () => target.dispose() };
}

export function CarViewer({
  car,
  className,
  spin = true,
}: {
  car: CarDefinition;
  className?: string;
  /** Slowly rotate the car. Off for the hero, where it sits at one fixed angle. */
  spin?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let frame = 0;
    // Set once the static path takes over: from then on a resize is the only thing
    // that needs a fresh frame.
    let renderOnResize = false;
    // Set once the model is in and its bounds are known. Until then a resize only
    // has the canvas size to update.
    let fitCamera: (() => void) | null = null;
    const disposables: { dispose: () => void }[] = [];

    const renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      // Transparent: the card's own surface shows through, so the viewer does not
      // have to keep a clear colour in step with the palette.
      alpha: true,
      powerPreference: "default",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new Scene();
    const environment = buildEnvironment(renderer);
    scene.environment = environment.texture;
    disposables.push(environment);

    const camera = new PerspectiveCamera(34, 1, 0.1, 100);

    // Key light high and to one side, plus fill: enough to read the panel creases
    // without flattening what the reflection probe is doing.
    const key = new DirectionalLight(0xfff0dc, 2.4);
    key.position.set(4, 6, 3);
    scene.add(key);
    const rim = new DirectionalLight(0xbfd4ff, 1.1);
    rim.position.set(-5, 3, -4);
    scene.add(rim);
    scene.add(new AmbientLight(0xffe6cc, 0.5));

    const turntable = new Group();
    scene.add(turntable);

    const resources = new Resources();

    const resize = () => {
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Re-solve the fit: the distance depends on the aspect ratio that just changed.
      fitCamera?.();
      // The spinning path repaints every frame anyway; the static one has to be
      // told, or the car stretches until the next mount.
      if (renderOnResize && !disposed) renderer.render(scene, camera);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    void (async () => {
      try {
        const model = await resources.load(car.model);
        if (disposed) return;

        const instance = resources.instantiate(model);
        const { yOffset } = resources.prepareCar(instance, {
          targetLength: car.targetLength,
          sourceSize: model.size,
          anisotropy: 8,
          castShadow: false,
          envMapIntensity: 1,
        });
        instance.rotation.y = car.modelYaw;
        instance.position.y = yOffset + car.modelYOffset;
        turntable.add(instance);

        // Frame on what actually arrived rather than on the configured length: the
        // two agree today, and if they ever stop the car should still be in shot.
        const bounds = new Box3().setFromObject(instance);
        const centre = bounds.getCenter(new Vector3());

        // The eight corners of the model's box, relative to its centre. Projecting
        // these onto the camera's own axes gives the car's true silhouette in the
        // frame, which is what the fit has to be solved against.
        const corners: Vector3[] = [];
        for (const x of [bounds.min.x, bounds.max.x]) {
          for (const y of [bounds.min.y, bounds.max.y]) {
            for (const z of [bounds.min.z, bounds.max.z]) {
              corners.push(new Vector3(x, y, z).sub(centre));
            }
          }
        }

        const direction = new Vector3(
          Math.sin(AZIMUTH) * Math.cos(ELEVATION),
          Math.sin(ELEVATION),
          Math.cos(AZIMUTH) * Math.cos(ELEVATION),
        ).normalize();

        /**
         * Solve the camera distance so the car fills the canvas on its tighter axis.
         *
         * Recomputed on every resize, because the answer depends on the aspect
         * ratio: the same car needs to be further away in a tall narrow window than
         * in a wide one, and a fixed distance has to be padded for the worst case
         * everywhere — which is the empty space this replaces.
         */
        fitCamera = () => {
          const forward = direction.clone().negate();
          const right = new Vector3()
            .crossVectors(new Vector3(0, 1, 0), forward)
            .normalize();
          const up = new Vector3().crossVectors(forward, right).normalize();

          let halfWidth = 0;
          let halfHeight = 0;
          let halfDepth = 0;
          for (const corner of corners) {
            halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
            halfHeight = Math.max(halfHeight, Math.abs(corner.dot(up)));
            halfDepth = Math.max(halfDepth, Math.abs(corner.dot(forward)));
          }

          const tanY = Math.tan((camera.fov * Math.PI) / 360);
          const tanX = tanY * camera.aspect;
          // Whichever axis runs out of room first decides it, plus the half-depth so
          // the nearest corner cannot poke through the near plane.
          const distance =
            Math.max(halfHeight / tanY, halfWidth / tanX) * FRAMING + halfDepth;

          // Aim above the car by most of the spare vertical room, which drops the car
          // to the bottom of the frame and collects the empty space at the top.
          const slack = Math.max(0, distance * tanY - halfHeight);
          const aim = centre.clone().addScaledVector(up, slack * LOW_IN_FRAME);

          camera.position.copy(aim).addScaledVector(direction, distance);
          camera.lookAt(aim);
          camera.updateProjectionMatrix();
        };

        // No contact shadow. An unlit disc under the car was standing in for one,
        // and on a transparent canvas it does not read as shadow — it reads as a
        // hard black ellipse painted on the page, because there is no ground for it
        // to fall on. Nothing is cleaner than a fake.

        resize();
        setState("ready");

        // Static: draw once, then only when the canvas resizes. A turntable that is
        // not turning has no reason to hold a `requestAnimationFrame` loop open and
        // keep the GPU warm behind a menu. The resize handler already re-renders.
        if (!spin || reduceMotion) {
          renderOnResize = true;
          renderer.render(scene, camera);
          return;
        }

        let last = performance.now();
        const tick = (now: number) => {
          if (disposed) return;
          const dt = Math.min((now - last) / 1000, 0.1);
          last = now;
          turntable.rotation.y += SPIN * dt;
          renderer.render(scene, camera);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      } catch {
        if (!disposed) setState("failed");
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();

      // Geometry and textures come from the GLB, so they are walked rather than
      // tracked: `Resources` shares them between clones and nothing else here holds
      // a reference once the scene is torn down.
      scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        node.geometry.dispose();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          // Every map the material holds, whatever it is called. Walking the
          // properties covers `map`, `normalMap`, `roughnessMap` and the clearcoat
          // maps this car actually uses, without listing them and missing one.
          for (const value of Object.values(material)) {
            if (value instanceof Texture) value.dispose();
          }
          material.dispose();
        }
      });
      for (const item of disposables) item.dispose();
      scene.clear();
      resources.dispose();
      renderer.dispose();
    };
  }, [car]);

  return (
    <div className={cn("relative", className)}>
      <canvas ref={canvasRef} className="size-full" />
      {state !== "ready" ? (
        <p className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.16em] text-cream/40">
          {state === "loading" ? "Loading model" : "Model unavailable"}
        </p>
      ) : null}
    </div>
  );
}
