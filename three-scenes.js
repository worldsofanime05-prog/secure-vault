// ================================================
// SecureVault 3D — Three.js Scenes
// ================================================

// ---- HERO SCENE (unchanged) ----
let heroScene, heroCam, heroRenderer, heroParticles, heroShapes = [];
let mouseX = 0, mouseY = 0;

function initHeroScene() {
  const heroCanvas = document.getElementById('hero-canvas');
  heroScene = new THREE.Scene();
  heroCam = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  heroCam.position.z = 30;
  heroRenderer = new THREE.WebGLRenderer({ canvas: heroCanvas, alpha: true, antialias: true });
  heroRenderer.setSize(window.innerWidth, window.innerHeight);
  heroRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const pCount = 1500, pGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(pCount * 3), colors = new Float32Array(pCount * 3);
  const cyan = new THREE.Color(0x00e5ff), purple = new THREE.Color(0x7c3aed);
  for (let i = 0; i < pCount; i++) {
    positions[i * 3] = (Math.random() - .5) * 80; positions[i * 3 + 1] = (Math.random() - .5) * 80; positions[i * 3 + 2] = (Math.random() - .5) * 80;
    const c = Math.random() > .5 ? cyan : purple;
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  heroParticles = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: .12, vertexColors: true, transparent: true, opacity: .8, sizeAttenuation: true }));
  heroScene.add(heroParticles);
  [{ geo: new THREE.IcosahedronGeometry(3, 1), color: 0x00e5ff, pos: [-12, 5, -10] }, { geo: new THREE.TorusKnotGeometry(2, .6, 100, 16), color: 0x7c3aed, pos: [14, -4, -8] }, { geo: new THREE.OctahedronGeometry(2.5, 0), color: 0xf43f5e, pos: [-8, -8, -5] }, { geo: new THREE.TorusGeometry(2, .5, 16, 50), color: 0x22c55e, pos: [10, 8, -12] }, { geo: new THREE.DodecahedronGeometry(2, 0), color: 0xf59e0b, pos: [0, -10, -15] }].forEach(s => {
    const mat = new THREE.MeshBasicMaterial({ color: s.color, wireframe: true, transparent: true, opacity: .35 });
    const mesh = new THREE.Mesh(s.geo, mat); mesh.position.set(...s.pos);
    mesh.userData = { speed: .3 + Math.random() * .7, floatOffset: Math.random() * Math.PI * 2 };
    heroScene.add(mesh); heroShapes.push(mesh);
  });
}
function animateHero() {
  requestAnimationFrame(animateHero); const t = Date.now() * .001;
  heroParticles.rotation.y += .0003; heroParticles.rotation.x += .0001;
  heroParticles.position.x += (mouseX * 5 - heroParticles.position.x) * .02;
  heroParticles.position.y += (-mouseY * 5 - heroParticles.position.y) * .02;
  heroShapes.forEach(s => { s.rotation.x += .003 * s.userData.speed; s.rotation.y += .005 * s.userData.speed; s.position.y += Math.sin(t * s.userData.speed + s.userData.floatOffset) * .008 });
  heroRenderer.render(heroScene, heroCam);
}

// ================================================
// INTERACTIVE 3D ANALYTICS
// ================================================
let anaScene, anaCam, anaRenderer, anaBars = [];
let anaRaycaster, anaMouse, anaCanvas;
let orbitState = { isDragging: false, prevX: 0, prevY: 0, theta: 0, phi: Math.PI / 4, radius: 16 };
let hoveredBar = null, selectedBar = null;
let anaLabelsContainer, anaTooltip, anaDetailPanel;
let currentVaultRef = []; // reference to vault data for drill-down

const barColors = [0x00e5ff, 0x7c3aed, 0x22c55e, 0xf59e0b, 0xf43f5e, 0x06b6d4, 0x8b5cf6, 0xef4444, 0x10b981, 0xf97316, 0x6366f1, 0x64748b];
const strengthColors = { strong: 0x22c55e, medium: 0xf59e0b, weak: 0xf43f5e };

function initAnalyticsScene() {
  anaCanvas = document.getElementById('analytics-canvas');
  const wrapper = anaCanvas.parentElement;

  // Create overlay containers
  anaLabelsContainer = document.createElement('div');
  anaLabelsContainer.className = 'ana-labels-container';
  wrapper.style.position = 'relative';
  wrapper.appendChild(anaLabelsContainer);

  anaTooltip = document.createElement('div');
  anaTooltip.className = 'ana-tooltip';
  anaTooltip.style.display = 'none';
  wrapper.appendChild(anaTooltip);

  // Scene setup
  anaScene = new THREE.Scene();
  anaCam = new THREE.PerspectiveCamera(50, wrapper.clientWidth / wrapper.clientHeight, .1, 200);
  updateCameraFromOrbit();

  anaRenderer = new THREE.WebGLRenderer({ canvas: anaCanvas, alpha: true, antialias: true });
  anaRenderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
  anaRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Lighting
  anaScene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const d1 = new THREE.DirectionalLight(0x00e5ff, 0.7); d1.position.set(5, 10, 7); anaScene.add(d1);
  const d2 = new THREE.DirectionalLight(0x7c3aed, 0.3); d2.position.set(-5, 8, -5); anaScene.add(d2);

  // Grid floor
  const grid = new THREE.GridHelper(24, 24, 0x1a1a3e, 0x0d0d2b);
  anaScene.add(grid);

  // Ambient particles
  const apCount = 200, apGeo = new THREE.BufferGeometry(), apPos = new Float32Array(apCount * 3);
  for (let i = 0; i < apCount; i++) { apPos[i * 3] = (Math.random() - .5) * 24; apPos[i * 3 + 1] = Math.random() * 12; apPos[i * 3 + 2] = (Math.random() - .5) * 24 }
  apGeo.setAttribute('position', new THREE.BufferAttribute(apPos, 3));
  anaScene.add(new THREE.Points(apGeo, new THREE.PointsMaterial({ size: .05, color: 0x00e5ff, transparent: true, opacity: .3 })));

  // Raycaster
  anaRaycaster = new THREE.Raycaster();
  anaMouse = new THREE.Vector2();

  // --- Interaction events ---
  anaCanvas.addEventListener('mousedown', onAnaMouseDown);
  anaCanvas.addEventListener('mousemove', onAnaMouseMove);
  anaCanvas.addEventListener('mouseup', onAnaMouseUp);
  anaCanvas.addEventListener('mouseleave', onAnaMouseUp);
  anaCanvas.addEventListener('click', onAnaClick);
  anaCanvas.addEventListener('wheel', onAnaWheel, { passive: false });
  // Touch
  anaCanvas.addEventListener('touchstart', onAnaTouchStart, { passive: false });
  anaCanvas.addEventListener('touchmove', onAnaTouchMove, { passive: false });
  anaCanvas.addEventListener('touchend', onAnaMouseUp);

  // Instructions hint
  const hint = document.createElement('div');
  hint.className = 'ana-hint';
  hint.textContent = '🖱️ Drag to rotate • Scroll to zoom • Click a bar for details';
  wrapper.appendChild(hint);
  setTimeout(() => hint.style.opacity = '0', 4000);
  setTimeout(() => hint.remove(), 5000);
}

// ---- Orbit controls (manual) ----
function updateCameraFromOrbit() {
  const { theta, phi, radius } = orbitState;
  anaCam.position.x = radius * Math.sin(phi) * Math.sin(theta);
  anaCam.position.y = radius * Math.cos(phi);
  anaCam.position.z = radius * Math.sin(phi) * Math.cos(theta);
  anaCam.lookAt(0, 2, 0);
}

function onAnaMouseDown(e) { orbitState.isDragging = true; orbitState.prevX = e.clientX; orbitState.prevY = e.clientY; anaCanvas.style.cursor = 'grabbing'; }
function onAnaMouseUp() { orbitState.isDragging = false; anaCanvas.style.cursor = 'grab'; }
function onAnaMouseMove(e) {
  const rect = anaCanvas.getBoundingClientRect();
  anaMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  anaMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  if (orbitState.isDragging) {
    const dx = e.clientX - orbitState.prevX, dy = e.clientY - orbitState.prevY;
    orbitState.theta -= dx * .005;
    orbitState.phi = Math.max(.3, Math.min(Math.PI / 2 - .05, orbitState.phi - dy * .005));
    orbitState.prevX = e.clientX; orbitState.prevY = e.clientY;
    updateCameraFromOrbit();
  } else {
    // Hover detection
    anaRaycaster.setFromCamera(anaMouse, anaCam);
    const hits = anaRaycaster.intersectObjects(anaBars.map(b => b.mesh));
    if (hits.length > 0) {
      const bar = anaBars.find(b => b.mesh === hits[0].object);
      if (bar && bar !== hoveredBar) {
        if (hoveredBar) hoveredBar.mesh.material.emissiveIntensity = 0;
        hoveredBar = bar;
        bar.mesh.material.emissiveIntensity = .3;
        anaCanvas.style.cursor = 'pointer';
      }
      // Tooltip
      if (bar) {
        const data = bar.userData;
        anaTooltip.innerHTML = `<strong>${data.category}</strong><br>${data.count} password${data.count !== 1 ? 's' : ''}<br>Avg: ${data.avgStrength}`;
        anaTooltip.style.display = 'block';
        anaTooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        anaTooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      }
    } else {
      if (hoveredBar) { hoveredBar.mesh.material.emissiveIntensity = 0; hoveredBar = null; }
      anaTooltip.style.display = 'none';
      if (!orbitState.isDragging) anaCanvas.style.cursor = 'grab';
    }
  }
}
function onAnaWheel(e) {
  e.preventDefault();
  orbitState.radius = Math.max(6, Math.min(30, orbitState.radius + e.deltaY * .02));
  updateCameraFromOrbit();
}
// Touch handlers
let touchStart = null;
function onAnaTouchStart(e) {
  if (e.touches.length === 1) {
    e.preventDefault();
    const t = e.touches[0]; orbitState.isDragging = true; orbitState.prevX = t.clientX; orbitState.prevY = t.clientY;
  }
}
function onAnaTouchMove(e) {
  if (e.touches.length === 1 && orbitState.isDragging) {
    e.preventDefault();
    const t = e.touches[0];
    const dx = t.clientX - orbitState.prevX, dy = t.clientY - orbitState.prevY;
    orbitState.theta -= dx * .005;
    orbitState.phi = Math.max(.3, Math.min(Math.PI / 2 - .05, orbitState.phi - dy * .005));
    orbitState.prevX = t.clientX; orbitState.prevY = t.clientY;
    updateCameraFromOrbit();
  }
}

function onAnaClick(e) {
  const rect = anaCanvas.getBoundingClientRect();
  anaMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  anaMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  anaRaycaster.setFromCamera(anaMouse, anaCam);
  const hits = anaRaycaster.intersectObjects(anaBars.map(b => b.mesh));
  if (hits.length > 0) {
    const bar = anaBars.find(b => b.mesh === hits[0].object);
    if (bar) showBarDetail(bar);
  } else {
    hideBarDetail();
  }
}

// ---- Build / update bars ----
function rebuildAnalyticsBars(categories) {
  // Clean old
  anaBars.forEach(b => { anaScene.remove(b.mesh); if (b.glow) anaScene.remove(b.glow); });
  anaBars = [];
  anaLabelsContainer.innerHTML = '';
  const count = categories.length;
  const spacing = Math.min(2.2, 16 / Math.max(count, 1));
  const offset = (count - 1) * spacing / 2;

  categories.forEach((cat, i) => {
    const color = barColors[i % barColors.length];
    const geo = new THREE.BoxGeometry(spacing * .55, 1, spacing * .55);
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: .88, emissive: color, emissiveIntensity: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(i * spacing - offset, 0.5, 0);
    mesh.scale.y = 0.01;
    anaScene.add(mesh);

    // Glow ring at base
    const ringGeo = new THREE.RingGeometry(spacing * .3, spacing * .38, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .25, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(i * spacing - offset, 0.02, 0);
    anaScene.add(ring);

    // Label element
    const label = document.createElement('div');
    label.className = 'ana-bar-label';
    label.textContent = cat;
    anaLabelsContainer.appendChild(label);

    anaBars.push({
      mesh, glow: ring, label, posX: i * spacing - offset,
      userData: { category: cat, count: 0, targetHeight: .01, avgStrength: '—', passwords: [] }
    });
  });
}

function updateAnalyticsBars(vault) {
  currentVaultRef = vault;
  const catData = {};
  vault.forEach(v => {
    if (!catData[v.category]) catData[v.category] = { count: 0, passwords: [], strengths: [] };
    const s = typeof getStrength === 'function' ? getStrength(v.password) : 'medium';
    catData[v.category].count++;
    catData[v.category].passwords.push(v);
    catData[v.category].strengths.push(s);
  });
  const maxCount = Math.max(1, ...Object.values(catData).map(d => d.count));

  anaBars.forEach(bar => {
    const d = catData[bar.userData.category];
    if (d) {
      bar.userData.count = d.count;
      bar.userData.passwords = d.passwords;
      bar.userData.targetHeight = (d.count / maxCount) * 7 + .5;
      // Avg strength
      const sMap = { strong: 3, medium: 2, weak: 1 };
      const avg = d.strengths.reduce((a, s) => a + (sMap[s] || 1), 0) / d.strengths.length;
      bar.userData.avgStrength = avg >= 2.5 ? 'Strong' : avg >= 1.5 ? 'Medium' : 'Weak';
      // Color bar by avg strength
      const sColor = avg >= 2.5 ? strengthColors.strong : avg >= 1.5 ? strengthColors.medium : strengthColors.weak;
      bar.mesh.material.color.setHex(sColor);
      bar.mesh.material.emissive.setHex(sColor);
      if (bar.glow) bar.glow.material.color.setHex(sColor);
    } else {
      bar.userData.count = 0;
      bar.userData.passwords = [];
      bar.userData.targetHeight = .15;
      bar.userData.avgStrength = '—';
    }
  });
}

// ---- Show detail panel when bar is clicked ----
function showBarDetail(bar) {
  // Highlight selected
  if (selectedBar && selectedBar !== bar) selectedBar.mesh.material.emissiveIntensity = 0;
  selectedBar = bar;
  bar.mesh.material.emissiveIntensity = .5;

  const d = bar.userData;
  let panel = document.getElementById('anaDetailPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'anaDetailPanel';
    panel.className = 'ana-detail-panel';
    anaCanvas.parentElement.appendChild(panel);
  }
  panel.style.display = 'block';

  let weakList = '', strongList = '', ageList = '';
  const now = Date.now();
  d.passwords.forEach(p => {
    const s = typeof getStrength === 'function' ? getStrength(p.password) : 'medium';
    const age = p.created ? Math.floor((now - p.created) / 86400000) : '?';
    const ageWarn = (typeof age === 'number' && age > 90) ? ' ⚠️ OLD' : '';
    if (s === 'weak') weakList += `<li class="detail-weak">⚠️ ${esc(p.site)} — <em>${esc(p.username)}</em></li>`;
    if (s === 'strong') strongList += `<li class="detail-strong">✅ ${esc(p.site)}</li>`;
    ageList += `<li>${esc(p.site)} — ${age}d${ageWarn}</li>`;
  });

  panel.innerHTML = `
    <div class="ana-detail-header">
      <h4>${esc(d.category)}</h4>
      <button class="ana-detail-close" onclick="hideBarDetail()">✕</button>
    </div>
    <div class="ana-detail-stats">
      <span class="detail-stat">${d.count} passwords</span>
      <span class="detail-stat detail-${d.avgStrength.toLowerCase()}">Avg: ${d.avgStrength}</span>
    </div>
    ${weakList ? `<div class="ana-detail-section"><h5>⚠️ Weak Passwords</h5><ul>${weakList}</ul></div>` : '<div class="ana-detail-section"><h5>✅ No weak passwords!</h5></div>'}
    ${strongList ? `<div class="ana-detail-section"><h5>💪 Strong Passwords</h5><ul>${strongList}</ul></div>` : ''}
    <div class="ana-detail-section"><h5>📅 Password Age</h5><ul>${ageList || '<li>No data</li>'}</ul></div>
  `;
}

function hideBarDetail() {
  if (selectedBar) { selectedBar.mesh.material.emissiveIntensity = 0; selectedBar = null; }
  const panel = document.getElementById('anaDetailPanel');
  if (panel) panel.style.display = 'none';
}
window.hideBarDetail = hideBarDetail;

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---- Get strength (fallback if not loaded yet) ----
function getStrength(p) {
  let s = 0; if (p.length >= 8) s++; if (p.length >= 14) s++; if (p.length >= 20) s++;
  if (/[a-z]/.test(p)) s++; if (/[A-Z]/.test(p)) s++; if (/[0-9]/.test(p)) s++; if (/[^a-zA-Z0-9]/.test(p)) s++;
  return s <= 3 ? 'weak' : s <= 5 ? 'medium' : 'strong';
}

// ---- Animation ----
function animateAnalytics() {
  requestAnimationFrame(animateAnalytics);
  const t = Date.now() * .001;

  // Auto-rotate when not interacting
  if (!orbitState.isDragging && !hoveredBar) {
    orbitState.theta += .003;
    updateCameraFromOrbit();
  }

  // Animate bar heights
  anaBars.forEach(bar => {
    const cur = bar.mesh.scale.y;
    const tgt = bar.userData.targetHeight || .01;
    bar.mesh.scale.y += (tgt - cur) * .04;
    bar.mesh.position.y = bar.mesh.scale.y * .5;

    // Floating label position (project 3D to 2D)
    if (bar.label && anaRenderer) {
      const pos = new THREE.Vector3(bar.posX, bar.mesh.scale.y + .7, 0);
      pos.project(anaCam);
      const w = anaCanvas.clientWidth, h = anaCanvas.clientHeight;
      const x = (pos.x * .5 + .5) * w;
      const y = (-(pos.y) * .5 + .5) * h;
      bar.label.style.left = x + 'px';
      bar.label.style.top = y + 'px';
      bar.label.style.opacity = (pos.z < 1) ? '1' : '0';
      // Show count
      bar.label.textContent = bar.userData.category + (bar.userData.count ? ' (' + bar.userData.count + ')' : '');
    }

    // Subtle pulse on glow ring
    if (bar.glow) bar.glow.material.opacity = .15 + Math.sin(t * 2 + bar.posX) * .08;
  });

  anaRenderer.render(anaScene, anaCam);
}

// ---- Resize ----
function handleResize() {
  heroCam.aspect = window.innerWidth / window.innerHeight;
  heroCam.updateProjectionMatrix();
  heroRenderer.setSize(window.innerWidth, window.innerHeight);
  const w = document.getElementById('analytics-canvas').parentElement;
  anaCam.aspect = w.clientWidth / w.clientHeight;
  anaCam.updateProjectionMatrix();
  anaRenderer.setSize(w.clientWidth, w.clientHeight);
}

window.addEventListener('mousemove', e => {
  mouseX = (e.clientX / window.innerWidth) * 2 - 1;
  mouseY = (e.clientY / window.innerHeight) * 2 - 1;
});
window.addEventListener('resize', handleResize);
