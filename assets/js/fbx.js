import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from "three-mesh-bvh";

// The FBX version of main.js (the STL page): same viewer and annotations, used by fbx.html

/* =========================================================
       SETTINGS — change these for your project
       ========================================================= */
// ?file=hiiro loads fbx/hiiro/model.fbx + fbx/hiiro/annotations.json (plain folder names only);
// without it the page starts empty, ready to open a new FBX
const fileParam = new URLSearchParams(location.search).get("file") ?? "";
const FILE = /^[\w-]+$/.test(fileParam) ? fileParam : "";

const CONFIG = {
  title: FILE, // shown in the panel and the browser tab once the model loads
  modelUrl: FILE && `fbx/${FILE}/model.fbx`, // your FBX, placed next to this file (separate texture files go beside it)
  annotationsUrl: FILE && `fbx/${FILE}/annotations.json`, // exported annotations, placed next to this file
  zUp: false, // FBX files are usually Y-up
  annotationZoom: 0.6, // how close the camera gets to an opened annotation (× model radius; smaller = closer)
  zoomIn: 0.5, // closest you can zoom (× model radius from the point the view turns around; smaller = closer)
  zoomOut: 2, // farthest you can zoom (× the starting distance; bigger = farther)
  editable: true, // set to false before publishing so visitors only view
};
// URL tips: add ?edit to edit on a published page, or ?view to preview what visitors see.
// e.g. fbx.html?view&file=hiiro — add &home=false, &autorotate=false or &fullscreen=false to hide those buttons

// Fast raycasting for big models (placing points + hiding hotspots behind the model)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const params = new URLSearchParams(location.search);
const EDIT = !params.has("view") && (CONFIG.editable || params.has("edit"));
document.body.classList.toggle("editing", EDIT);

const $ = (sel) => document.querySelector(sel);
const viewer = $("#viewer");
const hotspotLayer = $("#hotspots");
const popup = $("#popup");
const list = $("#list");
const dlg = $("#editor");
showTitle("");

/* ---------- Scene ---------- */
let flight = null;
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewer.prepend(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(
  new RoomEnvironment(renderer),
  0.04,
).texture;

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
camera.position.set(3, 2, 3);
scene.add(camera);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(1, 2, 1.5);
camera.add(keyLight);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3d45, 0.5));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotateSpeed = 2.5;
controls.addEventListener("start", () => {
  flight = null;
});

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

function resize() {
  const w = viewer.clientWidth,
    h = viewer.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewer);
resize();

/* ---------- Model ---------- */
let model = null; // the FBX scene: a group of parts
let meshes = []; // its visible meshes: what clicks and hotspot hiding test against
let modelName = "";
let zUp = CONFIG.zUp;
let radius = 1;

function setModel(object, name) {
  const parts = [];
  object.traverseVisible((o) => {
    if (o.isMesh && o.geometry.getAttribute("position")?.count) parts.push(o);
  });
  if (!parts.length) throw new Error("The model contains no triangles");
  if (model) {
    scene.remove(model);
    disposeModel(model);
  }
  for (const { geometry, isSkinnedMesh } of parts) {
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    // Bones and morphs move vertices the BVH doesn't know about, so those keep three.js's own raycast
    if (!isSkinnedMesh && !geometry.morphAttributes.position && !geometry.boundsTree)
      geometry.computeBoundsTree();
  }
  model = object;
  meshes = parts;
  scene.add(model);
  modelName = name;
  $("#model-name").textContent = name;
  // Buttons that need a model
  $("#btn-add").hidden = false;
  $('[data-action="import"]').disabled = false;
  $('[data-action="export"]').disabled = false;
  showEmpty(false);
  closePopup();
  setPlaceMode(null);
  setAxis(CONFIG.zUp);
}

function disposeModel(object) {
  object.traverse((o) => {
    if (!o.isMesh && !o.isLine && !o.isPoints) return;
    o.geometry.disposeBoundsTree?.();
    o.geometry.dispose();
    for (const m of [].concat(o.material)) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

/* ---------- FBX materials and textures ---------- */
// FBX materials (Phong / Lambert) become the same PBR material the STL page uses, so models
// are lit the same way. These are the properties that carry over: colors, textures, transparency.
const FBX_MATERIAL_KEYS = [
  "name",
  "color",
  "map",
  "emissive",
  "emissiveMap",
  "normalMap",
  "normalScale",
  "bumpMap",
  "bumpScale",
  "aoMap",
  "alphaMap",
  "opacity",
  "transparent",
  "vertexColors",
];

function fbxMaterial(m) {
  if (!m.isMeshPhongMaterial && !m.isMeshLambertMaterial) return m;
  const params = { metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide };
  for (const key of FBX_MATERIAL_KEYS) {
    const v = m[key];
    // A texture that never loaded (file not supplied, PSD...) would paint the surface black
    if (v == null || (v.isTexture && v.version === 0)) continue;
    params[key] = v;
  }
  m.dispose();
  return new THREE.MeshStandardMaterial(params);
}

// `path` is the site folder an FBX was loaded from: its texture files are looked up there.
// For an uploaded FBX, `files` are the files picked or dropped with it, and its textures are
// matched to them by file name (textures packed inside the FBX need nothing extra).
async function fbxModel(buffer, path, files) {
  const byName = new Map(files?.map((f) => [f.name.toLowerCase(), f]));
  const blobUrls = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("blob:")) blobUrls.push(url); // a packed texture
    if (!files || /^(blob|data):/.test(url)) return url;
    const file = byName.get(url.split(/[\\/]/).pop().toLowerCase());
    if (!file) return "data:,"; // not supplied: fail fast instead of requesting it from this site
    const fileUrl = URL.createObjectURL(file);
    blobUrls.push(fileUrl);
    return fileUrl;
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  let loadingTextures = false;
  manager.onStart = () => (loadingTextures = true);
  const texturesDone = new Promise((resolve) => (manager.onLoad = resolve));

  const group = new FBXLoader(manager).parse(buffer, path);
  if (loadingTextures) await texturesDone;
  blobUrls.forEach((url) => URL.revokeObjectURL(url));

  // Lights and cameras saved in the file would fight the viewer's own lighting and framing
  const extras = [];
  group.traverse((o) => {
    if (o.isLight || o.isCamera) extras.push(o);
  });
  extras.forEach((o) => o.removeFromParent());
  const converted = new Map(); // parts often share materials
  const convert = (m) => {
    if (!converted.has(m)) converted.set(m, fbxMaterial(m));
    return converted.get(m);
  };
  group.traverse((o) => {
    if (o.isMesh)
      o.material = Array.isArray(o.material)
        ? o.material.map(convert)
        : convert(o.material);
  });
  return group;
}

// The tab and panel show the model's name once one is loaded, just "RamzMesh" before
function showTitle(name) {
  document.title = name ? `RamzMesh - ${name}` : "RamzMesh";
  $("#title").textContent = name;
  $("#title").hidden = !name;
}

// Center the model and scale it to a standard size. Transforms live on the model's root,
// so annotation coordinates stay in the file's own units.
function normalizeModel() {
  model.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0);
  model.position.set(0, 0, 0);
  model.scale.setScalar(1);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.scale.setScalar(2 / (Math.max(size.x, size.y, size.z) || 1));
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  model.position.sub(box.getCenter(new THREE.Vector3()));
  model.updateMatrixWorld(true);
  occDirty = true;
}

function setAxis(z) {
  zUp = z;
  $("#axis-label").textContent = zUp ? "Z↑" : "Y↑";
  if (model) {
    normalizeModel();
    frameModel(false);
  }
}

function homeView() {
  const sphere = new THREE.Box3()
    .setFromObject(model)
    .getBoundingSphere(new THREE.Sphere());
  radius = sphere.radius;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.1;
  const dir = new THREE.Vector3(1, 0.65, 1.3).normalize();
  return {
    position: sphere.center.clone().addScaledVector(dir, dist),
    target: sphere.center.clone(),
    dist,
  };
}

function frameModel(animate = true) {
  if (!model) return;
  const v = homeView();
  camera.near = v.dist / 200;
  camera.far = v.dist * 50;
  camera.updateProjectionMatrix();
  // Opened annotations can always be reached, even with zoomIn set farther than annotationZoom
  controls.minDistance = radius * Math.min(CONFIG.zoomIn, CONFIG.annotationZoom);
  controls.maxDistance = v.dist * CONFIG.zoomOut;
  flyTo(v.position, v.target, animate);
}

/* ---------- Camera flights (smooth orbit to a saved view) ---------- */
const _q = new THREE.Quaternion(),
  _qId = new THREE.Quaternion();
function flyTo(pos, target, animate = true) {
  if (!animate) {
    flight = null;
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
    return;
  }
  const fromOff = camera.position.clone().sub(controls.target);
  const toOff = pos.clone().sub(target);
  flight = {
    fromT: controls.target.clone(),
    toT: target.clone(),
    fromLen: fromOff.length(),
    toLen: toOff.length(),
    fromDir: fromOff.clone().normalize(),
    q: new THREE.Quaternion().setFromUnitVectors(
      fromOff.clone().normalize(),
      toOff.clone().normalize(),
    ),
    start: performance.now(),
    dur: 900,
  };
}
function stepFlight(now) {
  const f = flight;
  const t = Math.min(1, (now - f.start) / f.dur);
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  controls.target.lerpVectors(f.fromT, f.toT, e);
  _q.slerpQuaternions(_qId, f.q, e);
  const len = THREE.MathUtils.lerp(f.fromLen, f.toLen, e);
  camera.position
    .copy(f.fromDir)
    .applyQuaternion(_q)
    .multiplyScalar(len)
    .add(controls.target);
  if (t >= 1) flight = null;
}

const toWorld = (arr) => model.localToWorld(new THREE.Vector3().fromArray(arr));
const toLocal = (v) =>
  model
    .worldToLocal(v.clone())
    .toArray()
    .map((n) => Math.round(n * 1e4) / 1e4);

/* ---------- Annotations ---------- */
// Each annotation: { title, text, position:[x,y,z], view:{ position:[...], target:[...] } }
// Coordinates are in the FBX's own space.
let annotations = [];
let activeIndex = -1;
let hotspotEls = [];
let listEls = [];

function renderAnnotations() {
  hotspotLayer.replaceChildren();
  list.replaceChildren();
  hotspotEls = [];
  listEls = [];

  annotations.forEach((a, i) => {
    const label = a.title || `Annotation ${i + 1}`;

    const hs = document.createElement("button");
    hs.type = "button";
    hs.className = "hotspot";
    hs.textContent = String(i + 1);
    hs.title = label;
    hs.setAttribute("aria-label", label);
    hs.style.display = "none";
    hs.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!EDIT && i === activeIndex)
        closePopup(); // visitors click the point again to hide its info
      else goTo(i);
    });
    hotspotLayer.append(hs);
    hotspotEls.push(hs);

    const li = document.createElement("li");
    li.tabIndex = 0;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1);
    const body = document.createElement("div");
    body.className = "li-body";
    const t = document.createElement("div");
    t.className = "li-title";
    t.textContent = label;
    body.append(t);
    if (a.text) {
      const d = document.createElement("div");
      d.className = "li-text";
      d.textContent = a.text;
      body.append(d);
    }
    li.append(num, body);
    if (EDIT) {
      const tools = document.createElement("div");
      tools.className = "li-tools";
      tools.append(
        miniBtn("↑", "Move up", () => reorder(i, -1), i === 0),
        miniBtn(
          "↓",
          "Move down",
          () => reorder(i, 1),
          i === annotations.length - 1,
        ),
        miniBtn("✎", "Edit", () => openEditor(i, false)),
      );
      li.append(tools);
    }
    li.addEventListener("click", () => goTo(i));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === li) goTo(i);
    });
    list.append(li);
    listEls.push(li);
  });

  if (!annotations.length) {
    const li = document.createElement("li");
    li.className = "empty-list";
    li.textContent = EDIT
      ? model
        ? "No annotations yet. Click “Add annotation”, then click a spot on the model."
        : "Load an FBX to start annotating."
      : "No annotations.";
    list.append(li);
  }

  $("#count").textContent =
    `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`;
  updateActive();
  occDirty = true;
}

function miniBtn(txt, title, fn, disabled) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini";
  b.textContent = txt;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.disabled = !!disabled;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function reorder(i, d) {
  const j = i + d;
  if (j < 0 || j >= annotations.length) return;
  [annotations[i], annotations[j]] = [annotations[j], annotations[i]];
  if (activeIndex === i) activeIndex = j;
  else if (activeIndex === j) activeIndex = i;
  persist();
  renderAnnotations();
  if (activeIndex >= 0) showPopup();
}

function updateActive() {
  hotspotEls.forEach((el, i) =>
    el.classList.toggle("active", i === activeIndex),
  );
  listEls.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
}

function goTo(i) {
  const n = annotations.length;
  if (!n || !model) return;
  activeIndex = ((i % n) + n) % n;
  const a = annotations[activeIndex];
  // Look from the saved angle (or the current one), zoomed in close to the point
  const target = toWorld(a.position);
  const offset = a.view
    ? toWorld(a.view.position).sub(toWorld(a.view.target))
    : camera.position.clone().sub(controls.target);
  const dist = Math.min(offset.length(), radius * CONFIG.annotationZoom);
  flyTo(target.clone().addScaledVector(offset.normalize(), dist), target);
  stopAutoRotate();
  showPopup();
  updateActive();
  listEls[activeIndex]?.scrollIntoView({
    block: "nearest",
    behavior: "smooth",
  });
}

function showPopup() {
  const a = annotations[activeIndex];
  if (!a) return closePopup();
  $("#popup-num").textContent = String(activeIndex + 1);
  $("#popup-title").textContent = a.title || `Annotation ${activeIndex + 1}`;
  const t = $("#popup-text");
  t.textContent = a.text;
  t.hidden = !a.text;
  $("#popup-count").textContent = `${activeIndex + 1} / ${annotations.length}`;
  popup.hidden = false;
  updateActive();
}

function closePopup() {
  activeIndex = -1;
  popup.hidden = true;
  updateActive();
}

/* ---------- Hotspot positions + hiding behind the model ---------- */
const _p = new THREE.Vector3(),
  _d = new THREE.Vector3();
const lastCam = new THREE.Vector3(Infinity, 0, 0),
  lastTgt = new THREE.Vector3();
let occDirty = true;
let lastOccTime = 0;

function updateHotspots(now) {
  if (!model || !hotspotEls.length) return;
  const w = viewer.clientWidth,
    h = viewer.clientHeight;
  // Anchor the popup to its hotspot in view mode when there's room beside a centered point
  const anchor = !EDIT && w >= 640;
  if (popup.classList.contains("anchored") !== anchor) {
    popup.classList.toggle("anchored", anchor);
    popup.style.transform = popup.style.visibility = "";
    popupAt = null;
  }
  const placePopup = anchor && !popup.hidden;
  const pw = placePopup ? popup.offsetWidth : 0,
    ph = placePopup ? popup.offsetHeight : 0;
  let ax = 0,
    ay = 0,
    aVisible = false;
  const moved =
    camera.position.distanceToSquared(lastCam) > 1e-10 ||
    controls.target.distanceToSquared(lastTgt) > 1e-10;
  const checkOcc = (moved || occDirty) && now - lastOccTime > 100;
  if (checkOcc) {
    lastOccTime = now;
    occDirty = false;
    lastCam.copy(camera.position);
    lastTgt.copy(controls.target);
  }
  for (let i = 0; i < hotspotEls.length; i++) {
    const el = hotspotEls[i];
    model.localToWorld(_p.fromArray(annotations[i].position));
    if (checkOcc) {
      _d.subVectors(_p, camera.position);
      const dist = _d.length();
      if (dist > 0) {
        raycaster.set(camera.position, _d.divideScalar(dist));
        raycaster.far = dist;
        const hit = raycaster.intersectObjects(meshes, false)[0];
        el.classList.toggle(
          "occluded",
          !!hit && hit.distance < dist - radius * 0.01,
        );
      }
    }
    _p.project(camera);
    if (_p.z > 1 || _p.z < -1) {
      el.style.display = "none";
      continue;
    }
    const x = ((_p.x + 1) / 2) * w,
      y = ((1 - _p.y) / 2) * h;
    el.style.display = "";
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    if (i === activeIndex) {
      ax = x;
      ay = y;
      aVisible = x >= 0 && x <= w && y >= 0 && y <= h;
    }
  }
  if (placePopup) positionPopup(ax, ay, aVisible, pw, ph, w, h);
}

// Place the popup just right of the hotspot (left when it doesn't fit), its title level with the point
let popupAt = null; // unrounded position last applied
function positionPopup(x, y, visible, pw, ph, w, h) {
  popup.style.visibility = visible ? "" : "hidden";
  if (!visible) return;
  const gap = 22,
    m = 12;
  const flip = x + gap + pw > w - m && x - gap - pw >= m;
  const left = Math.max(m, Math.min(flip ? x - gap - pw : x + gap, w - pw - m));
  const top = Math.max(m, Math.min(y - 22, h - ph - m));
  // Skip sub-pixel changes: a point sitting on a half pixel (odd-sized viewer) would
  // otherwise round 1px back and forth while the camera settles, making the popup shake
  if (
    popupAt &&
    Math.abs(left - popupAt.left) < 0.6 &&
    Math.abs(top - popupAt.top) < 0.6
  )
    return;
  popupAt = { left, top };
  popup.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/* ---------- Placing annotations on the model ---------- */
let placeMode = null; // null | { type: 'new' } | { type: 'move', index }

function setPlaceMode(mode) {
  placeMode = mode;
  viewer.classList.toggle("placing", !!mode);
  $("#hint").hidden = !mode;
  $("#hint-text").textContent =
    mode?.type === "move"
      ? `Click the new spot for annotation ${mode.index + 1}`
      : "Click on the model to place an annotation";
  $("#btn-add").classList.toggle("on", mode?.type === "new");
  $("#btn-add-label").textContent =
    mode?.type === "new" ? "Cancel placing" : "+ Add annotation";
}

function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
  raycaster.far = Infinity;
  return raycaster.intersectObjects(meshes, false)[0] || null;
}

let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  downAt = e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
});
renderer.domElement.addEventListener("pointerup", (e) => {
  const start = downAt;
  downAt = null;
  if (!start || !model || !e.isPrimary) return;
  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return; // it was a drag
  if (!placeMode) {
    if (!EDIT) closePopup(); // visitors close the info window by clicking elsewhere
    return;
  }
  const hit = pick(e);
  if (!hit) {
    toast("Click on the model itself");
    return;
  }
  const point = toLocal(hit.point);
  const view = { position: toLocal(camera.position), target: point };

  if (placeMode.type === "move") {
    const i = placeMode.index;
    annotations[i].position = point;
    annotations[i].view = view;
    setPlaceMode(null);
    persist();
    renderAnnotations();
    activeIndex = i;
    showPopup();
    toast("Annotation moved");
  } else {
    setPlaceMode(null);
    annotations.push({ title: "", text: "", position: point, view });
    renderAnnotations();
    activeIndex = annotations.length - 1;
    updateActive();
    openEditor(activeIndex, true);
  }
});

/* ---------- Editor dialog ---------- */
let editing = null;

function openEditor(index, isNew) {
  const a = annotations[index];
  if (!a) return;
  editing = { index, isNew, done: false };
  $("#editor-heading").textContent = isNew
    ? "New annotation"
    : `Edit annotation ${index + 1}`;
  $("#f-title").value = a.title;
  $("#f-text").value = a.text;
  $("#f-view").checked = false;
  $("#f-view-row").hidden = isNew;
  $("#btn-delete").hidden = isNew;
  $("#btn-move").hidden = isNew;
  dlg.showModal();
  $("#f-title").focus();
}

$("#editor-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!editing) return;
  const { index } = editing;
  const a = annotations[index];
  a.title = $("#f-title").value.trim();
  a.text = $("#f-text").value.trim();
  if ($("#f-view").checked) {
    a.view = {
      position: toLocal(camera.position),
      target: toLocal(controls.target),
    };
  }
  editing.done = true;
  dlg.close();
  persist();
  renderAnnotations();
  activeIndex = index;
  showPopup();
});

$("#btn-cancel").addEventListener("click", () => dlg.close());

$("#btn-delete").addEventListener("click", () => {
  if (!editing || !confirm("Delete this annotation?")) return;
  annotations.splice(editing.index, 1);
  editing.done = true;
  dlg.close();
  closePopup();
  persist();
  renderAnnotations();
});

$("#btn-move").addEventListener("click", () => {
  if (!editing) return;
  const i = editing.index;
  editing.done = true;
  dlg.close();
  setPlaceMode({ type: "move", index: i });
});

dlg.addEventListener("close", () => {
  // A brand-new annotation that was cancelled is discarded
  if (editing && editing.isNew && !editing.done) {
    annotations.splice(editing.index, 1);
    closePopup();
    renderAnnotations();
  }
  editing = null;
});

/* ---------- Saving, export, import ---------- */
const storageKey = () => `fbx-annotations:${modelName || "model"}`;

function exportData() {
  return {
    model: modelName,
    upAxis: zUp ? "z" : "y",
    annotations: annotations.map(({ title, text, position, view }) => ({
      title,
      text,
      position,
      view,
    })),
  };
}

function persist() {
  if (!EDIT || !model) return;
  try {
    localStorage.setItem(storageKey(), JSON.stringify(exportData()));
  } catch {
    /* storage unavailable */
  }
}

const isVec3 = (v) =>
  Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

function applyData(data) {
  const raw = Array.isArray(data?.annotations) ? data.annotations : [];
  annotations = raw
    .filter((a) => a && isVec3(a.position))
    .map((a) => ({
      title: String(a.title ?? ""),
      text: String(a.text ?? ""),
      position: [...a.position],
      view:
        a.view && isVec3(a.view.position) && isVec3(a.view.target)
          ? { position: [...a.view.position], target: [...a.view.target] }
          : null,
    }));
  if (data?.upAxis === "z" || data?.upAxis === "y")
    setAxis(data.upAxis === "z");
  closePopup();
  renderAnnotations();
}

async function loadAnnotations(fromConfig) {
  let data = null;
  if (EDIT) {
    try {
      const saved = localStorage.getItem(storageKey());
      if (saved) data = JSON.parse(saved);
    } catch {
      /* ignore */
    }
  }
  if (!data && fromConfig && CONFIG.annotationsUrl) {
    try {
      const res = await fetch(CONFIG.annotationsUrl, {
        cache: "no-cache",
      });
      if (res.ok) data = await res.json();
    } catch {
      /* no annotations file */
    }
  }
  applyData(data);
}

function exportJson() {
  if (!model) {
    toast("Load an FBX first");
    return;
  }
  const blob = new Blob([JSON.stringify(exportData(), null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "annotations.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Exported annotations.json");
}

async function importJson(file) {
  if (!model) {
    toast("Load the FBX first, then import its annotations");
    return;
  }
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.annotations))
      throw new Error("No annotations array");
    applyData(data);
    persist();
    toast(
      `Imported ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`,
    );
  } catch (err) {
    console.error(err);
    toast("That file isn’t a valid annotations.json");
  }
}

/* ---------- Loading FBX files ---------- */
async function loadFromUrl(url) {
  showLoader(true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const folder = url.slice(0, url.lastIndexOf("/") + 1);
    const group = await fbxModel(await res.arrayBuffer(), folder, null);
    // "hiiro/model.fbx": every folder's file is model.fbx, so keep the folder in the name (it keys saved drafts)
    setModel(
      group,
      decodeURIComponent(url.split("/").slice(-2).join("/").split("?")[0]),
    );
    showTitle(CONFIG.title);
    await loadAnnotations(true);
  } catch (err) {
    console.warn(`Could not load ${url}`, err);
    renderAnnotations();
    showEmpty(true);
  } finally {
    showLoader(false);
  }
}

// `files`: everything picked or dropped together with the FBX (its texture images)
async function loadFromFile(file, files) {
  showLoader(true);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // let the spinner paint
  try {
    setModel(await fbxModel(await file.arrayBuffer(), "", files), file.name);
    showTitle(file.name.replace(/\.fbx$/i, ""));
    await loadAnnotations(false);
  } catch (err) {
    console.error(err);
    toast("Could not read that FBX file");
  } finally {
    showLoader(false);
  }
}

// Picked or dropped files: an FBX with any separate texture images, and/or an annotations.json
async function openFiles(list) {
  const files = Array.from(list);
  const fbx = files.find((f) => /\.fbx$/i.test(f.name));
  const json = files.find((f) => /\.json$/i.test(f.name));
  if (fbx) await loadFromFile(fbx, files);
  if (json) importJson(json);
  else if (!fbx) toast("Please choose an .fbx file");
}

function showLoader(on) {
  $("#loader").hidden = !on;
}
function showEmpty(on) {
  $("#empty").hidden = !on;
}

$("#fbx-input").addEventListener("change", (e) => {
  if (e.target.files.length) openFiles(e.target.files);
  e.target.value = "";
});
$("#json-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) importJson(f);
  e.target.value = "";
});

// Drag & drop (edit mode)
let dragDepth = 0;
const hasFiles = (e) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!EDIT || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  viewer.classList.add("dragging");
});
window.addEventListener("dragover", (e) => {
  if (EDIT && hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!EDIT || !hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    viewer.classList.remove("dragging");
  }
});
window.addEventListener("drop", (e) => {
  if (!EDIT || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  viewer.classList.remove("dragging");
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

/* ---------- Buttons & keys ---------- */
const autoBtn = $('[data-action="autorotate"]');
function stopAutoRotate() {
  controls.autoRotate = false;
  autoBtn.classList.remove("on");
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else
    $("#app")
      .requestFullscreen?.()
      .catch(() => {});
}
if (!document.fullscreenEnabled) $('[data-action="fullscreen"]').hidden = true;

// ?home=false&autorotate=false&fullscreen=false hide those top-right buttons
const toolParams = {
  home: "reset",
  autorotate: "autorotate",
  fullscreen: "fullscreen",
};
for (const [param, action] of Object.entries(toolParams)) {
  const v = params.get(param)?.toLowerCase();
  if (v === "false" || v === "0") $(`[data-action="${action}"]`).hidden = true;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  switch (btn.dataset.action) {
    case "open-fbx":
      $("#fbx-input").click();
      break;
    case "import":
      $("#json-input").click();
      break;
    case "export":
      exportJson();
      break;
    case "add":
      if (!model) {
        toast("Load an FBX first");
        break;
      }
      setPlaceMode(placeMode?.type === "new" ? null : { type: "new" });
      break;
    case "cancel-place":
      setPlaceMode(null);
      break;
    case "reset":
      frameModel(true);
      break;
    case "autorotate":
      controls.autoRotate = !controls.autoRotate;
      autoBtn.classList.toggle("on", controls.autoRotate);
      break;
    case "axis":
      if (!model) break;
      setAxis(!zUp);
      persist();
      toast(zUp ? "Up axis: Z" : "Up axis: Y");
      break;
    case "fullscreen":
      toggleFullscreen();
      break;
    case "close":
      closePopup();
      break;
    case "prev":
      goTo(activeIndex - 1);
      break;
    case "next":
      goTo(activeIndex + 1);
      break;
    case "edit":
      if (activeIndex >= 0) openEditor(activeIndex, false);
      break;
  }
});

window.addEventListener("keydown", (e) => {
  if (dlg.open || e.target.closest("input, textarea")) return;
  if (e.key === "Escape") {
    if (placeMode) setPlaceMode(null);
    else closePopup();
  } else if (e.key === "ArrowRight" && annotations.length) {
    goTo(activeIndex + 1);
  } else if (e.key === "ArrowLeft" && annotations.length) {
    goTo(activeIndex < 0 ? annotations.length - 1 : activeIndex - 1);
  }
});

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

/* ---------- Render loop ---------- */
function loop(now) {
  requestAnimationFrame(loop);
  if (flight) stepFlight(now);
  controls.update();
  renderer.render(scene, camera);
  updateHotspots(now);
}
requestAnimationFrame(loop);

/* ---------- Start ---------- */
if (location.protocol === "file:" && CONFIG.modelUrl) {
  const note = $("#file-note");
  note.innerHTML =
    "To load <code></code> automatically, open this page through a web server instead of double-clicking it.";
  note.querySelector("code").textContent = CONFIG.modelUrl;
  note.hidden = false;
}
// Visitors see the model turning until they open an annotation
if (!EDIT) {
  controls.autoRotate = true;
  autoBtn.classList.add("on");
}
setAxis(CONFIG.zUp);
if (CONFIG.modelUrl) loadFromUrl(CONFIG.modelUrl);
else {
  renderAnnotations();
  showEmpty(true);
}
