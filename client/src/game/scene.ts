import * as THREE from 'three';

// Touch/coarse-pointer devices are usually weaker GPUs; cap render cost
// conservatively there without touching desktop visual quality.
const IS_TOUCH = typeof window !== 'undefined' &&
  (('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0);

export function createScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: !IS_TOUCH });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Cap DPR lower on touch (retina phones report 3) so fill-rate stays sane.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = IS_TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfe4f5);
  // Fog blends the ground into the sky colour so the map edge is never a
  // hard "end of the world" line at any comfortable camera distance.
  scene.fog = new THREE.Fog(0xbfe4f5, 120, 250);

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.5,
    600
  );

  const hemi = new THREE.HemisphereLight(0xeaf6ff, 0x9ac47a, 0.95);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
  sun.position.set(70, 110, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  sun.shadow.camera.far = 300;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
}
