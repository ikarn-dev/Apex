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
  type Texture,
  type WebGLRenderer,
} from "three";
import type { LevelEnvironment } from "../config/levels";
import type { QualitySettings } from "../config/quality";

export interface WorldResult {
  scene: Scene;
  sun: DirectionalLight;
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

function buildSkyDome(env: LevelEnvironment, radius: number): Mesh {
  const geometry = new SphereGeometry(radius, 24, 16);
  const top = new Color(env.skyTop);
  const bottom = new Color(env.skyBottom);

  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const mixed = new Color();

  for (let i = 0; i < position.count; i += 1) {
    // Normalised height across the dome, biased so the gradient concentrates
    // near the horizon where it is actually seen.
    const y = position.getY(i) / radius;
    const t = Math.pow(Math.max(0, y * 0.5 + 0.5), 0.55);
    mixed.copy(bottom).lerp(top, t);
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
  // Always drawn first and never occludes anything.
  mesh.renderOrder = -1;
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

  const skyRadius = Math.max(quality.drawDistance * 0.95, trackRadius * 2.4);
  const sky = buildSkyDome(env, skyRadius);
  dressing.add(sky);
  disposables.push(sky.geometry, sky.material as MeshBasicMaterial);

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
  scene.add(
    new HemisphereLight(env.skyTop, env.ground, env.ambientIntensity * 0.55),
  );

  return {
    scene,
    sun,
    dispose: () => {
      for (const item of disposables) item.dispose();
    },
  };
}
