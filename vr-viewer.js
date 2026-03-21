/**
 * vr-viewer.js
 * Three.js + WebXR immersive panorama engine for Apple Vision Pro.
 *
 * Loads Marzipano cube-map tiles from https://saishashang.github.io/tiles/
 * and renders them as a 360° skybox inside a WebXR immersive-vr session.
 *
 * Tile URL pattern:  tiles/{sceneId}/{level}/{face}/{row}/{col}.jpg
 * Face names (Marzipano standard): f, b, l, r, u, d
 * Levels: 1 (lowest, single tile per face), 2, 3 (highest, multi-tile)
 * At level 1 each face is a single tile at row=0, col=0.
 */

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

const TILE_BASE = 'https://saishashang.github.io/tiles/';

/**
 * Zoom level to load.
 *   1 = lowest quality, single tile per face (fast, best for initial load)
 *   2 = medium quality, 2×2 tiles per face
 *   3 = highest quality, 4×4 tiles per face (requires tile stitching)
 */
const FACE_LEVEL = 1;

/**
 * Three.js CubeTextureLoader expects faces in order: [+X, -X, +Y, -Y, +Z, -Z]
 * Mapping to Marzipano face names:
 *   +X = right  → 'r'
 *   -X = left   → 'l'
 *   +Y = up     → 'u'
 *   -Y = down   → 'd'
 *   +Z = back   → 'b'  (Three.js camera looks toward -Z, so "back" is +Z)
 *   -Z = front  → 'f'
 *
 * If the panorama appears 180° rotated, swap 'f'↔'b' in this array.
 * If left/right are mirrored, swap 'r'↔'l'.
 */
const FACE_MAP = ['r', 'l', 'u', 'd', 'b', 'f'];

// ─── Scene definitions ────────────────────────────────────────────────────────

export const SCENES = [
  { id: '0-reception01',  label: 'Reception 01' },
  { id: '1-reception02',  label: 'Reception 02' },
  { id: '2-side01',       label: 'Side 01' },
  { id: '3-side02',       label: 'Side 02' },
  { id: '4-dh02',         label: 'Dining Hall 02' },
  { id: '5-dh03',         label: 'Dining Hall 03' },
  { id: '6-mf',           label: 'Medical Facility' },
  { id: '7-mr01',         label: 'Meeting Room 01' },
  { id: '8-mr02',         label: 'Meeting Room 02' },
  { id: '9-mr03',         label: 'Meeting Room 03' },
  { id: '10-mr04',        label: 'Meeting Room 04' },
  { id: '11-panm40002',   label: 'PANM 40002' },
  { id: '12-phonebooth',  label: 'Phone Booth' },
  { id: '13-ca01',        label: 'CA 01' },
  { id: '14-dh01',        label: 'Dining Hall 01' },
];

// ─── Internal state ───────────────────────────────────────────────────────────

/** @type {THREE.WebGLRenderer} */
let renderer;

/** @type {THREE.Scene} */
let threeScene;

/** @type {THREE.PerspectiveCamera} */
let camera;

/** @type {XRSession|null} */
let xrSession = null;

/** @type {Function|null} */
let onSceneChangeCallback = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a tile URL for a specific face of a scene at the configured face size.
 * Row and col are always 0 when faceSize === tileSize (single tile per face).
 */
function tileUrl(sceneId, face) {
  return `${TILE_BASE}${sceneId}/${FACE_LEVEL}/${face}/0/0.jpg`;
}

/**
 * Load a cube texture for the given scene ID.
 * Returns a promise that resolves with a THREE.CubeTexture.
 */
function loadCubeTexture(sceneId) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.CubeTextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      FACE_MAP.map(f => tileUrl(sceneId, f)),
      resolve,
      undefined,
      (err) => reject(new Error(`Failed to load tiles for "${sceneId}": ${err.message ?? err}`))
    );
  });
}

/**
 * Show or hide the loading overlay managed by the calling page.
 */
function setLoading(visible) {
  const el = document.getElementById('vr-loading');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether immersive-vr WebXR is supported in this browser.
 * @returns {Promise<boolean>}
 */
export async function checkVRSupport() {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

/**
 * Initialise the Three.js renderer and attach its canvas to #canvas-container.
 * Call this once after DOMContentLoaded.
 */
export function init() {
  const container = document.getElementById('canvas-container');

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.xr.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  threeScene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.01,
    1000
  );

  // Resize handler (non-XR viewport)
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Non-XR render loop — keeps the background canvas alive
  renderer.setAnimationLoop(() => {
    if (!renderer.xr.isPresenting) {
      renderer.render(threeScene, camera);
    }
  });
}

/**
 * Enter an immersive-vr WebXR session.
 *
 * @param {string}   initialSceneId   - Scene to load first (from SCENES[].id)
 * @param {Function} onSceneChange    - Called with the new sceneId when scene switches
 */
export async function enterVR(initialSceneId, onSceneChange) {
  onSceneChangeCallback = onSceneChange ?? null;

  try {
    // 1. Request XR session FIRST — must happen before any other await
    //    so the browser's transient user activation (gesture window) is still valid.
    const scenePanel = document.getElementById('scene-panel');
    const sessionInit = {
      requiredFeatures: ['local'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: scenePanel ? { root: scenePanel } : undefined,
    };
    xrSession = await navigator.xr.requestSession('immersive-vr', sessionInit);
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(xrSession);

    // 2. Session is live — now safe to load textures asynchronously
    setLoading(true);
    const texture = await loadCubeTexture(initialSceneId);
    threeScene.background = texture;

    // 3. Show the in-VR scene panel
    if (scenePanel) scenePanel.style.display = 'flex';
    setLoading(false);

    // 4. Session-end cleanup
    xrSession.addEventListener('end', () => {
      xrSession = null;
      if (scenePanel) scenePanel.style.display = 'none';
      setLoading(false);
    });

  } catch (err) {
    console.error('[VRViewer] enterVR failed:', err);
    setLoading(false);
    throw err;
  }
}

/**
 * Switch to a different panorama scene while inside a VR session (or in preview).
 * @param {string} sceneId
 */
export async function switchScene(sceneId) {
  setLoading(true);
  try {
    const texture = await loadCubeTexture(sceneId);

    // Dispose previous texture to free GPU memory
    if (threeScene.background instanceof THREE.CubeTexture) {
      threeScene.background.dispose();
    }
    threeScene.background = texture;

    onSceneChangeCallback?.(sceneId);
  } catch (err) {
    console.error('[VRViewer] switchScene failed:', err);
    alert(`Could not load scene "${sceneId}". Check console for details.`);
  } finally {
    setLoading(false);
  }
}

/**
 * End the active XR session and return to the flat browser view.
 */
export function exitVR() {
  xrSession?.end();
}
