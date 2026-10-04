import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export interface Engine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  controls: OrbitControls;
  /** Starts the frame loop; `frame` receives real seconds since last frame. */
  start(frame: (realDt: number) => void): void;
}

export function createEngine(container: HTMLElement): Engine {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfd4e6);
  scene.fog = new THREE.Fog(0xbfd4e6, 140, 320);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 1000);
  camera.position.set(40, 85, 120);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  container.appendChild(labels.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 15;
  controls.maxDistance = 300;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6b55, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(60, 120, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = s.bottom = -110;
  s.right = s.top = 110;
  s.far = 400;
  scene.add(sun);

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labels.setSize(w, h);
  };
  new ResizeObserver(resize).observe(container);
  resize();

  return {
    scene,
    camera,
    renderer,
    labels,
    controls,
    start(frame) {
      const timer = new THREE.Timer();
      renderer.setAnimationLoop((time) => {
        timer.update(time);
        frame(timer.getDelta());
        controls.update();
        renderer.render(scene, camera);
        labels.render(scene, camera);
      });
    },
  };
}
