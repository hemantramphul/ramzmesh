import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from "three-mesh-bvh";

/* =========================================================
       SETTINGS — change these for your project
       ========================================================= */
const CONFIG = {
  title: "model", // shown in the panel and the browser tab
  modelUrl: "stl/riio/model.stl", // your STL, placed next to this file
  annotationsUrl: "stl/riio/annotations.json", // exported annotations, placed next to this file
  zUp: true, // most CAD / 3D-printing STLs are Z-up
  modelColor: "#c9ccd3",
  annotationZoom: 0.6, // how close the camera gets to an opened annotation (× model radius; smaller = closer)
  editable: true, // set to false before publishing so visitors only view
};
// URL tips: add ?edit to edit on a published page, or ?view to preview what visitors see.

// Fast raycasting for big STLs (placing points + hiding hotspots behind the model)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const params = new URLSearchParams(location.search);
const EDIT = !params.has("view") && (CONFIG.editable || params.has("edit"));
document.body.classList.toggle("editing", EDIT);
document.title = `${CONFIG.title} — 3D Viewer`;

const $ = (sel) => document.querySelector(sel);
const viewer = $("#viewer");
const hotspotLayer = $("#hotspots");
const popup = $("#popup");
const list = $("#list");
const dlg = $("#editor");
$("#title").textContent = CONFIG.title;

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
const loader = new STLLoader();
let mesh = null;
let modelName = "";
let zUp = CONFIG.zUp;
let radius = 1;

function setModel(geometry, name) {
  const pos = geometry.getAttribute("position");
  if (!pos || pos.count === 0) throw new Error("STL contains no triangles");
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.disposeBoundsTree?.();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  geometry.computeBoundsTree();
  const material = new THREE.MeshStandardMaterial({
    color: geometry.hasColors ? 0xffffff : CONFIG.modelColor,
    vertexColors: !!geometry.hasColors,
    metalness: 0.1,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  modelName = name;
  $("#model-name").textContent = name;
  showEmpty(false);
  closePopup();
  setPlaceMode(null);
  setAxis(CONFIG.zUp);
}

// Center the model and scale it to a standard size. Transforms live on the mesh,
// so annotation coordinates stay in the STL's own units.
function normalizeModel() {
  mesh.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0);
  mesh.position.set(0, 0, 0);
  mesh.scale.setScalar(1);
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  mesh.scale.setScalar(2 / (Math.max(size.x, size.y, size.z) || 1));
  mesh.updateMatrixWorld(true);
  box.setFromObject(mesh);
  mesh.position.sub(box.getCenter(new THREE.Vector3()));
  mesh.updateMatrixWorld(true);
  occDirty = true;
}

function setAxis(z) {
  zUp = z;
  $("#axis-label").textContent = zUp ? "Z↑" : "Y↑";
  if (mesh) {
    normalizeModel();
    frameModel(false);
  }
}

function homeView() {
  const sphere = new THREE.Box3()
    .setFromObject(mesh)
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
  if (!mesh) return;
  const v = homeView();
  camera.near = v.dist / 200;
  camera.far = v.dist * 50;
  camera.updateProjectionMatrix();
  controls.minDistance = radius * 0.15;
  controls.maxDistance = v.dist * 5;
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

const toWorld = (arr) => mesh.localToWorld(new THREE.Vector3().fromArray(arr));
const toLocal = (v) =>
  mesh
    .worldToLocal(v.clone())
    .toArray()
    .map((n) => Math.round(n * 1e4) / 1e4);

/* ---------- Annotations ---------- */
// Each annotation: { title, text, position:[x,y,z], view:{ position:[...], target:[...] } }
// Coordinates are in the STL's own space.
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
      ? mesh
        ? "No annotations yet. Click “Add annotation”, then click a spot on the model."
        : "Load an STL to start annotating."
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
  if (!n || !mesh) return;
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
  if (!mesh || !hotspotEls.length) return;
  const w = viewer.clientWidth,
    h = viewer.clientHeight;
  // Anchor the popup to its hotspot in view mode when there's room beside a centered point
  const anchor = !EDIT && w >= 640;
  if (popup.classList.contains("anchored") !== anchor) {
    popup.classList.toggle("anchored", anchor);
    popup.style.transform = popup.style.visibility = "";
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
    mesh.localToWorld(_p.fromArray(annotations[i].position));
    if (checkOcc) {
      _d.subVectors(_p, camera.position);
      const dist = _d.length();
      if (dist > 0) {
        raycaster.set(camera.position, _d.divideScalar(dist));
        raycaster.far = dist;
        const hit = raycaster.intersectObject(mesh, false)[0];
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
function positionPopup(x, y, visible, pw, ph, w, h) {
  popup.style.visibility = visible ? "" : "hidden";
  if (!visible) return;
  const gap = 22,
    m = 12;
  const flip = x + gap + pw > w - m && x - gap - pw >= m;
  const left = Math.max(m, Math.min(flip ? x - gap - pw : x + gap, w - pw - m));
  const top = Math.max(m, Math.min(y - 22, h - ph - m));
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
  return raycaster.intersectObject(mesh, false)[0] || null;
}

let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  downAt = e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
});
renderer.domElement.addEventListener("pointerup", (e) => {
  const start = downAt;
  downAt = null;
  if (!start || !mesh || !e.isPrimary) return;
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
const storageKey = () => `stl-annotations:${modelName || "model"}`;

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
  if (!EDIT || !mesh) return;
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
  if (!mesh) {
    toast("Load an STL first");
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
  if (!mesh) {
    toast("Load the STL first, then import its annotations");
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

/* ---------- Loading STL files ---------- */
async function loadFromUrl(url) {
  showLoader(true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geometry = loader.parse(await res.arrayBuffer());
    setModel(geometry, decodeURIComponent(url.split("/").pop().split("?")[0]));
    await loadAnnotations(true);
  } catch (err) {
    console.warn(`Could not load ${url}`, err);
    renderAnnotations();
    showEmpty(true);
  } finally {
    showLoader(false);
  }
}

async function loadFromFile(file) {
  if (!/\.stl$/i.test(file.name)) {
    toast("Please choose an .stl file");
    return;
  }
  showLoader(true);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // let the spinner paint
  try {
    setModel(loader.parse(await file.arrayBuffer()), file.name);
    await loadAnnotations(false);
  } catch (err) {
    console.error(err);
    toast("Could not read that STL file");
  } finally {
    showLoader(false);
  }
}

function showLoader(on) {
  $("#loader").hidden = !on;
}
function showEmpty(on) {
  $("#empty").hidden = !on;
}

$("#stl-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadFromFile(f);
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
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) importJson(f);
  else loadFromFile(f);
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

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  switch (btn.dataset.action) {
    case "open-stl":
      $("#stl-input").click();
      break;
    case "import":
      $("#json-input").click();
      break;
    case "export":
      exportJson();
      break;
    case "add":
      if (!mesh) {
        toast("Load an STL first");
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
      if (!mesh) break;
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
if (location.protocol === "file:") {
  const note = $("#file-note");
  note.innerHTML =
    "To load <code></code> automatically, open this page through a web server instead of double-clicking it.";
  note.querySelector("code").textContent = CONFIG.modelUrl;
  note.hidden = false;
}
setAxis(CONFIG.zUp);
loadFromUrl(CONFIG.modelUrl);
