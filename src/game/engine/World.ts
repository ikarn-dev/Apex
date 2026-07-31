/**
 * Scene dressing: sky, ground, fog and lights.
 *
 * The sky is a vertex-coloured inverted sphere rather than a cubemap or an HDRI.
 * That is a deliberate trade: an equirectangular HDRI is 2-8MB and a cubemap is
 * six textures, and neither is visible for more than a few degrees above the
 * horizon in a chase camera. A gradient dome costs one draw call and nothing to
 * download, and the level's `env` palette drives it entirely.
 */

import {
  AmbientLight,
  BackSide,
  BufferAttribute,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PMREMGenerator,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from "three";
import type { LevelEnvironment } from "../config/levels";
import type { QualitySettings } from "../config/quality";

export interface WorldResult {
  scene: Scene;
  sun: DirectionalLight;
  /**
   * The sky dome.
   *
   * The engine re-centres it on the camera every frame. That is not decoration: the
   * dome has to sit inside the camera's far plane or the far plane clips it, and a
   * radius small enough to clear a 1,400m far plane is smaller than this circuit,
   * so a dome parked at the origin would leave the car driving outside the sky.
   */
  sky: Object3D;
  dispose: () => void;
}

/**
 * Image-based lighting from the sky gradient.
 *
 * Car paint is metallic, and a metallic surface with no environment to reflect
 * renders as near-black no matter how bright the sun is — which is exactly how
 * the cars were coming out. Pre-filtering the same gradient the sky dome uses
 * gives the bodywork something to reflect, costs one small render at load, and
 * needs no downloaded HDRI.
 */
function buildEnvironment(
  renderer: WebGLRenderer,
  env: LevelEnvironment,
): { texture: Texture; dispose: () => void } {
  const pmrem = new PMREMGenerator(renderer);
  const source = new Scene();

  const dome = buildSkyDome(env, 50);
  source.add(dome);

  // A ground disc so the lower hemisphere bounces grass light rather than black.
  const groundGeometry = new PlaneGeometry(400, 400, 1, 1);
  const groundMaterial = new MeshBasicMaterial({ color: env.ground, fog: false });
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -6;
  source.add(ground);

  const target = pmrem.fromScene(source, 0.04);

  dome.geometry.dispose();
  (dome.material as MeshBasicMaterial).dispose();
  groundGeometry.dispose();
  groundMaterial.dispose();
  pmrem.dispose();
  source.clear();

  return { texture: target.texture, dispose: () => target.dispose() };
}

/** Sample the level's sky gradient at a normalised height, 0 horizon to 1 zenith. */
function sampleSky(stops: readonly Color[], positions: readonly number[], t: number): Color {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 1; i < positions.length; i += 1) {
    const upper = positions[i]!;
    if (clamped > upper && i < positions.length - 1) continue;
    const lower = positions[i - 1]!;
    const span = upper - lower;
    const local = span > 1e-6 ? (clamped - lower) / span : 0;
    // Smoothstep between stops, so a five-stop list still reads as one continuous
    // wash rather than five visible bands.
    const eased = local * local * (3 - 2 * local);
    return stops[i - 1]!.clone().lerp(stops[i]!, Math.min(1, Math.max(0, eased)));
  }
  return stops[stops.length - 1]!.clone();
}

function buildSkyDome(env: LevelEnvironment, radius: number): Mesh {
  // More vertical segments than a two-colour wash needs: the gradient now carries
  // several stops, and banding shows up on a coarse dome.
  const geometry = new SphereGeometry(radius, 32, 28);
  const stops = env.sky.map((stop) => new Color(stop.color));
  const positions = env.sky.map((stop) => stop.at);

  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);

  for (let i = 0; i < position.count; i += 1) {
    // Height above the horizon, so the gradient is defined over the visible half of
    // the dome rather than the whole sphere.
    const y = position.getY(i) / radius;
    const mixed = sampleSky(stops, positions, y);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }

  geometry.setAttribute("color", new BufferAttribute(colors, 3));

  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = "sky";
  // Always drawn first and never occludes anything. The authored landscape uses
  // the next negative render band, then clears depth before circuit geometry.
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  return mesh;
}

export function buildWorld(
  env: LevelEnvironment,
  quality: QualitySettings,
  trackRadius: number,
  renderer: WebGLRenderer,
  /** Height the circuit's run-off banks down to. The ground plane sits here. */
  groundHeight: number,
): WorldResult {
  const scene = new Scene();
  scene.background = new Color(env.fog);
  scene.fog = new FogExp2(env.fog, env.fogDensity);

  const disposables: { dispose: () => void }[] = [];

  const environment = buildEnvironment(renderer, env);
  scene.environment = environment.texture;
  scene.environmentIntensity = 1;
  disposables.push(environment);
  const dressing = new Group();
  dressing.name = "world";

  // Inside the far plane, and camera-locked. The old radius was
  // `max(drawDistance * 0.95, trackRadius * 2.4)` — 2,590m against a 1,400m far
  // plane — so the far plane sliced the dome and left a hard arc across the sky.
  const dome = buildSkyDome(env, quality.drawDistance * 0.85);
  dome.frustumCulled = false;
  const sky = new Group();
  sky.name = "sky-anchor";
  sky.add(dome);
  scene.add(sky);
  disposables.push(dome.geometry, dome.material as MeshBasicMaterial);

  // Ground plane, generous enough to reach the fog in every direction.
  const groundSize = Math.max(trackRadius * 6, quality.drawDistance * 2);
  const groundGeometry = new PlaneGeometry(groundSize, groundSize, 1, 1);
  const groundMaterial = new MeshStandardMaterial({
    color: env.ground,
    roughness: 0.95,
    metalness: 0,
  });
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  // A shade under the height the circuit's run-off banks down to. The two used to
  // disagree — ground sat 80m below a circuit that climbs and drops 30m, so the
  // horizon read as a void under a floating road. Matching them closes it, and
  // the small offset keeps the two surfaces from z-fighting where they meet.
  ground.position.y = groundHeight - 0.15;
  // The render pass is deliberately layered: sky (-2), ground (-1.5), authored
  // landscape (-1), then circuit geometry (0+). The landscape clears depth after
  // itself so roads always win; drawing this opaque plane later would instead
  // overwrite the landscape colour and make the entire backdrop disappear.
  ground.renderOrder = -1.5;
  ground.name = "ground";
  ground.receiveShadow = quality.shadowMapSize > 0;
  dressing.add(ground);
  disposables.push(groundGeometry, groundMaterial);

  scene.add(dressing);

  // --- lighting ------------------------------------------------------------
  const sun = new DirectionalLight(env.sunColor, env.sunIntensity);
  const azimuth = env.sunAzimuth;
  const elevation = env.sunElevation;
  sun.position.set(
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.sin(azimuth) * Math.cos(elevation),
  ).multiplyScalar(300);
  sun.name = "sun";

  if (quality.shadowMapSize > 0) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    // A tight ortho box around the player, not the whole circuit: shadow
    // resolution is worth spending where the camera actually is. The engine
    // re-centres the light on the player every frame.
    const extent = 46;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 620;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.035;
  }
  scene.add(sun);
  scene.add(sun.target);

  scene.add(new AmbientLight(env.ambient, env.ambientIntensity));
  // Sky light comes from the zenith stop, ground bounce from the ground colour.
  const zenith = env.sky[env.sky.length - 1]!.color;
  scene.add(new HemisphereLight(zenith, env.ground, env.ambientIntensity * 0.55));

  return {
    scene,
    sun,
    sky,
    dispose: () => {
      for (const item of disposables) item.dispose();
    },
  };
}
