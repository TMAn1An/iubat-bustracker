/*
 * BusModels: real 3D buses on the MapLibre map (an IUBAT-style yellow bus with windows, wheels,
 * red stripe and lights), drawn with three.js in a MapLibre custom layer.
 * three.js is loaded only after the map is ready, so it never slows the app's first paint.
 * If it fails to load, the map keeps its simple extruded-box buses.
 */
(function () {
  const THREE_URL = '/vendor/three.min.js'; // three.js r149, served from this site
  const MIN_ZOOM = 12.5;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = THREE_URL; s.async = true;
      s.onload = () => (window.THREE ? res(window.THREE) : rej(new Error('three.js missing')));
      s.onerror = () => rej(new Error('three.js failed to load'));
      document.head.appendChild(s);
    });
  }

  // One bus, in metres: length along +x (front at +x), width along y, height along z (up).
  function makeBus(T) {
    const g = new T.Group();
    const lam = (c, extra) => new T.MeshLambertMaterial({ color: c, ...extra });
    const box = (w, d, h, mat, x, y, z) => { const m = new T.Mesh(new T.BoxGeometry(w, d, h), mat); m.position.set(x, y, z); g.add(m); return m; };
    const body = lam(0xf7c600, { transparent: true });
    g.userData.body = body;
    const glass = lam(0x22364c), dark = lam(0x1d2a22), red = lam(0xd92d20), roof = lam(0xeeeeea), tyre = lam(0x151816), hub = lam(0xb9c0bd);
    const L = 12, W = 2.5, Z0 = 0.45;
    box(L, W, 2.45, body, 0, 0, Z0 + 1.225);                    // body
    box(L + 0.02, W + 0.02, 0.26, dark, 0, 0, Z0 + 0.13);       // dark skirt
    box(L + 0.02, W + 0.02, 0.12, red, 0, 0, Z0 + 0.62);        // red stripe
    box(9.6, W + 0.04, 0.85, glass, -0.6, 0, Z0 + 1.75);        // side windows
    box(0.08, W - 0.2, 1.15, glass, L / 2 + 0.01, 0, Z0 + 1.6); // windscreen
    box(0.08, W - 0.3, 0.7, glass, -L / 2 - 0.01, 0, Z0 + 1.85);// rear window
    box(L - 0.3, W - 0.1, 0.1, roof, 0, 0, Z0 + 2.5);           // roof
    box(3.2, 1.5, 0.32, roof, -1, 0, Z0 + 2.7);                 // roof AC unit
    box(0.06, 1.6, 0.22, lam(0x10140f, { emissive: 0x332200 }), L / 2 + 0.03, 0, Z0 + 2.3); // destination sign
    for (const y of [-0.85, 0.85]) box(0.06, 0.32, 0.18, lam(0xfff7c8, { emissive: 0xfff2a0 }), L / 2 + 0.03, y, Z0 + 0.45); // headlights
    for (const y of [-0.95, 0.95]) box(0.06, 0.28, 0.2, lam(0xc62016, { emissive: 0x550000 }), -L / 2 - 0.03, y, Z0 + 0.5); // tail lights
    const wheel = new T.CylinderGeometry(0.52, 0.52, 0.32, 18), cap = new T.CylinderGeometry(0.28, 0.28, 0.34, 12);
    for (const x of [-3.7, 3.9]) for (const y of [-1.12, 1.12]) {
      const w = new T.Mesh(wheel, tyre); w.position.set(x, y, 0.52); g.add(w);   // cylinder axis is y = across the bus
      const c = new T.Mesh(cap, hub); c.position.set(x, y, 0.52); g.add(c);
    }
    g.traverse(o => { o.frustumCulled = false; });
    return g;
  }

  // column-major 4x4 multiply in double precision (avoids float32 jitter far from the origin)
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  }

  async function attach(map, getBuses) {
    const T = await loadThree();
    const layer = {
      id: 'bus-models', type: 'custom', renderingMode: '3d',
      onAdd(m, gl) {
        this.camera = new T.Camera(); this.scene = new T.Scene(); this.meshes = new Map();
        this.scene.add(new T.HemisphereLight(0xffffff, 0x556655, 0.85));
        const sun = new T.DirectionalLight(0xffffff, 0.75); sun.position.set(-40, -60, 100); this.scene.add(sun);
        this.renderer = new T.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
      },
      render(gl, matrix) {
        const zoom = map.getZoom(), list = getBuses() || [];
        const seen = new Set();
        if (zoom >= MIN_ZOOM && list.length) {
          // Place buses in metres relative to the map centre: small numbers, no precision jitter.
          const o = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter(), 0), ms = o.meterInMercatorCoordinateUnits();
          const boost = Math.min(6, Math.max(1.8, Math.pow(2, 17.2 - zoom))); // slightly larger than life so the bus stands out, more when zoomed out
          for (const b of list) {
            seen.add(b.id);
            let g = this.meshes.get(b.id);
            if (!g) { g = makeBus(T); this.meshes.set(b.id, g); this.scene.add(g); }
            const p = maplibregl.MercatorCoordinate.fromLngLat([b.lng, b.lat], 0);
            g.position.set((p.x - o.x) / ms, -(p.y - o.y) / ms, 0);
            g.rotation.z = (90 - b.heading) * Math.PI / 180;           // heading: degrees clockwise from north
            g.scale.setScalar(boost);
            const body = g.userData.body;
            body.color.setHex(b.status === 'offline' ? 0xb9bfb6 : 0xf7c600);
            body.opacity = b.status === 'estimated' ? 0.55 : 1;
            g.visible = true;
          }
          const L = [ms, 0, 0, 0, 0, -ms, 0, 0, 0, 0, ms, 0, o.x, o.y, o.z, 1];
          this.camera.projectionMatrix.fromArray(mul(Array.from(matrix), L));
        }
        this.meshes.forEach((g, id) => { if (!seen.has(id)) g.visible = false; });
        if (!seen.size) return;
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
      },
    };
    map.addLayer(layer);
    return layer;
  }

  window.BusModels = { attach };
})();
