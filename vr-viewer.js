/**
 * vr-viewer.js
 * Three.js + WebXR immersive panorama engine for Apple Vision Pro.
 *
 * Look around  → move your head (XR pose tracking, automatic)
 * Switch scene → pinch thumb + index finger (XR select event, cycles scenes)
 * Exit VR      → press the Digital Crown on Vision Pro
 *
 * Tile URL: https://saishashang.github.io/tiles/{sceneId}/{level}/{face}/{row}/{col}.jpg
 */

import * as THREE from 'three';

// ─── Constants ────────────────────────────────────────────────────────────────

const TILE_BASE  = 'https://saishashang.github.io/tiles/';
const FACE_LEVEL = 1;

// Three.js CubeTextureLoader order: [+X, -X, +Y, -Y, +Z, -Z]
// Marzipano: r=right(+X) l=left(-X) u=up(+Y) d=down(-Y) b=back(+Z) f=front(-Z)
const FACE_MAP = ['r', 'l', 'u', 'd', 'b', 'f'];

// ─── Scenes ───────────────────────────────────────────────────────────────────

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

// ─── State ────────────────────────────────────────────────────────────────────

let renderer, threeScene, camera;
let xrSession = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tileUrl(sceneId, face) {
  return `${TILE_BASE}${sceneId}/${FACE_LEVEL}/${face}/0/0.jpg`;
}

function setLoading(visible) {
  const el = document.getElementById('vr-loading');
  if (el) el.style.display = visible ? 'flex' : 'none';
}

/**
 * Load cube-map tiles for a scene.
 * minFilter + generateMipmaps = false reduces visible seams at face edges.
 */
function loadCubeTexture(sceneId) {
  return new Promise((resolve, reject) => {
    new THREE.CubeTextureLoader()
      .setCrossOrigin('anonymous')
      .load(
        FACE_MAP.map(f => tileUrl(sceneId, f)),
        (tex) => {
          tex.minFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          resolve(tex);
        },
        undefined,
        (err) => reject(new Error(`Tile load failed for "${sceneId}": ${err.message ?? err}`))
      );
  });
}

async function switchScene(sceneId) {
  setLoading(true);
  try {
    const tex = await loadCubeTexture(sceneId);
    if (threeScene.background instanceof THREE.CubeTexture) {
      threeScene.background.dispose();
    }
    threeScene.background = tex;
  } catch (err) {
    console.error('[VRViewer] switchScene failed:', err);
  } finally {
    setLoading(false);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Snap-turn the XR view by angleDeg degrees around the Y axis.
 * Positive = turn left (counterclockwise from above), negative = turn right.
 * Works by offsetting the XR reference space; head tracking still applies on top.
 */
function snapTurn(angleDeg) {
  const space = renderer.xr.getReferenceSpace();
  if (!space) return;
  const half = THREE.MathUtils.degToRad(angleDeg / 2);
  const transform = new XRRigidTransform(
    { x: 0, y: 0, z: 0, w: 1 },                          // no position offset
    { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) } // Y-axis quaternion
  );
  renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(transform));
}

export async function checkVRSupport() {
  if (!navigator.xr) return false;
  try { return await navigator.xr.isSessionSupported('immersive-vr'); }
  catch { return false; }
}

export function init() {
  const container = document.getElementById('canvas-container');

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.xr.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  threeScene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 1000);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Three.js WebXR: always call render() — XR system updates camera pose automatically
  renderer.setAnimationLoop(() => renderer.render(threeScene, camera));
}

export async function enterVR(initialSceneId, onSceneChange) {
  try {
    // requestSession MUST be called before any other await (user gesture window)
    xrSession = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local'],
    });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(xrSession);

    // Session live — load panorama
    setLoading(true);
    const tex = await loadCubeTexture(initialSceneId);
    threeScene.background = tex;
    setLoading(false);

    // Pinch gestures — left hand = turn left 45°, right hand = turn right 45°
    // Rotates the XR reference space so the view snaps in that direction.
    // Head tracking continues to work on top of the offset.
    xrSession.addEventListener('select', (event) => {
      const hand = event.inputSource.handedness; // 'left' | 'right' | 'none'
      if (hand === 'left')  snapTurn(+45);
      else if (hand === 'right') snapTurn(-45);
    });

    xrSession.addEventListener('end', () => {
      xrSession = null;
      setLoading(false);
    });

  } catch (err) {
    console.error('[VRViewer] enterVR failed:', err);
    setLoading(false);
    throw err;
  }
}

export function exitVR() {
  xrSession?.end();
}
