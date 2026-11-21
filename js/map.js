/*
 * BusMap: MapLibre GL (OpenStreetMap data, OpenFreeMap tiles) with 3D buildings.
 * A bus = a 3D bus model (js/bus3d.js, three.js) + a numbered pin; a simple extruded box is the fallback.
 */
(function () {
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const rad = Math.PI / 180;
  const EMPTY = { type: 'FeatureCollection', features: [] };

  class BusMap {
    constructor(el, { routes, campus, onSelect }) {
      this.routes = routes; this.campus = campus; this.onSelect = onSelect;
      this.selected = null; this.selectedRoute = null; this.follow = false; this.buses = new Map(); this.stopMarks = [];
      this.pad = { top: 0, bottom: 0, left: 0, right: 0 };
      this.map = new maplibregl.Map({
        container: el, style: STYLE, center: [campus.lng, campus.lat], zoom: 11.6, pitch: 55, bearing: -15,
        maxPitch: 75, attributionControl: { compact: true }, canvasContextAttributes: { antialias: true },
      });
      this.map.dragRotate.enable(); this.map.touchZoomRotate.enableRotation();
      this.ready = new Promise(res => this.map.on('load', () => { this._layers(); this._campus(); res(); this._models(); }));
      // stop following when the user drags the map
      this.map.on('dragstart', e => { if (e.originalEvent) this.follow = false; });
          }

    // Swap the simple boxes for real 3D bus models once three.js has loaded (in the background).
    _models() {
      if (!window.BusModels) return;
      BusModels.attach(this.map, () => this._modelData).then(() => {
        this.models = true;
        if (this.map.getLayer('bus-3d')) this.map.setLayoutProperty('bus-3d', 'visibility', 'none');
        this.buses.forEach(e => e.marker.setOffset([0, -44]));
      }).catch(e => console.warn('3D bus models unavailable, using simple boxes:', e.message));
    }

    _layers() {
      const m = this.map;
      m.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: this.routes.map(r => ({
        type: 'Feature', properties: { id: r.id, color: r.color }, geometry: { type: 'LineString', coordinates: r.geometry } })) } });
      m.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: this.routes.flatMap(r => r.stops.map(s => ({
        type: 'Feature', properties: { id: r.id, color: r.color, name: s.name }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }))) } });
      m.addSource('buses', { type: 'geojson', data: EMPTY });
      const before = m.getStyle().layers.find(l => l.type === 'symbol')?.id; // below labels
      m.addLayer({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 15, 12], 'line-opacity': .85 } }, before);
      m.addLayer({ id: 'route-line', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 7], 'line-opacity': .55 } }, before);
      m.addLayer({ id: 'stop-dot', type: 'circle', source: 'stops', minzoom: 11,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 7], 'circle-color': '#fff', 'circle-stroke-width': 2.5, 'circle-stroke-color': ['get', 'color'] } });
      m.addLayer({ id: 'bus-3d', type: 'fill-extrusion', source: 'buses', minzoom: 13.5, paint: {
        'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': true } });
      this._highlight();
    }

    /** Called when the admin changes routes: refresh the route/stop layers. */
    setRoutes(routes) {
      this.routes = routes;
      const m = this.map; if (!m.getSource('routes')) return;
      m.getSource('routes').setData({ type: 'FeatureCollection', features: routes.map(r => ({
        type: 'Feature', properties: { id: r.id, color: r.color }, geometry: { type: 'LineString', coordinates: r.geometry } })) });
      m.getSource('stops').setData({ type: 'FeatureCollection', features: routes.flatMap(r => r.stops.map(s => ({
        type: 'Feature', properties: { id: r.id, color: r.color, name: s.name }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }))) });
      this._highlight(); this._stopLabels();
    }

    _highlight() {
      const m = this.map; if (!m.getLayer('route-line')) return;
      const sel = this.selectedRoute || (this.selected && this.buses.get(this.selected)?.routeId);
      m.setPaintProperty('route-line', 'line-opacity', sel ? ['case', ['==', ['get', 'id'], sel], 1, .22] : .6);
      m.setPaintProperty('route-line', 'line-width', ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, sel ? ['case', ['==', ['get', 'id'], sel], 10, 4] : 7]);
      m.setPaintProperty('route-casing', 'line-opacity', sel ? ['case', ['==', ['get', 'id'], sel], .95, .25] : .85);
      m.setFilter('stop-dot', sel ? ['==', ['get', 'id'], sel] : null);
    }

    _campus() {
      const el = document.createElement('div'); el.className = 'campus-pin';
      el.innerHTML = '<img src="assets/logo.png" alt=""><span>IUBAT Campus</span>';
      new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([this.campus.lng, this.campus.lat]).addTo(this.map);
    }

    /** Every frame: [{id,lng,lat,heading,color,status,routeId}] */
    setBuses(list) {
      if (!this.map.getSource('buses')) return;
      this._modelData = list;
      const seen = new Set(), feats = [];
      list.forEach(b => {
        seen.add(b.id);
        let e = this.buses.get(b.id);
        if (!e) {
          const el = document.createElement('button'); el.className = 'bus-pin'; el.type = 'button';
          el.setAttribute('aria-label', 'Bus ' + b.id);
          el.innerHTML = `<b>${b.id}</b>`;
          el.addEventListener('click', ev => { ev.stopPropagation(); this.onSelect(b.id); });
          e = { el, marker: new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, this.models ? -44 : -4] }).setLngLat([b.lng, b.lat]).addTo(this.map) };
          this.buses.set(b.id, e);
        }
        e.routeId = b.routeId; e.lng = b.lng; e.lat = b.lat; e.live = b.status !== 'offline';
        e.marker.setLngLat([b.lng, b.lat]);
        e.el.className = 'bus-pin ' + b.status + (b.id === this.selected ? ' sel' : '');
        e.el.style.setProperty('--route', b.color);
        e.el.style.zIndex = b.id === this.selected ? 5 : 1;
        feats.push(this._box(b));
      });
      this.buses.forEach((e, id) => { if (!seen.has(id)) { e.marker.remove(); this.buses.delete(id); } });
      this.map.getSource('buses').setData({ type: 'FeatureCollection', features: feats });
      if (this.follow && this.selected && this.buses.get(this.selected)) {
        const e = this.buses.get(this.selected), c = this.map.getCenter();
        this.map.setCenter([c.lng + (e.lng - c.lng) * 0.18, c.lat + (e.lat - c.lat) * 0.18]);
      }
    }

    // Bus footprint (about 12 m x 3 m), rotated to the heading
    _box(b) {
      const L = 6.2, W = 1.5, h = b.heading * rad, fx = Math.sin(h), fy = Math.cos(h), rx = fy, ry = -fx;
      const kx = 111320 * Math.cos(b.lat * rad), ky = 110574;
      const c = [[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]].map(([a, s]) => [
        b.lng + (a * L * fx + s * W * rx) / kx, b.lat + (a * L * fy + s * W * ry) / ky]);
      return { type: 'Feature', properties: { h: 3.3, color: b.status === 'offline' ? '#b9bfb6' : '#f2b705' }, geometry: { type: 'Polygon', coordinates: [c] } };
    }

    /** Focus a route: highlight it, follow its live bus if there is one, otherwise show the whole route. */
    selectRoute(routeId, busId) {
      this.selectedRoute = routeId; this.selected = busId || null; this.follow = false;
      this._highlight(); this._stopLabels();
      const e = busId && this.buses.get(busId);
      if (e && e.live) {
        this._followAfterMove(busId);
        this.map.flyTo({ center: [e.lng, e.lat], zoom: Math.max(this.map.getZoom(), 15), pitch: 55, speed: 1.2, padding: this.pad, essential: true });
        return;
      }
      const r = this.routes.find(x => x.id === routeId); if (!r) return;
      const b = r.geometry.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(r.geometry[0], r.geometry[0]));
      this.map.fitBounds(b, { padding: { top: 60, left: 60, right: 80, bottom: 60 + (this.pad.bottom || 0) }, pitch: 40, duration: 900, maxZoom: 15 });
    }

    select(id) {
      this.selectedRoute = null;
      this.selected = id; this._highlight(); this._stopLabels();
      const e = id && this.buses.get(id);
      this.follow = false;
      if (e) {
        this._followAfterMove(id);
        this.map.flyTo({ center: [e.lng, e.lat], zoom: Math.max(this.map.getZoom(), 15.6), pitch: Math.max(this.map.getPitch(), 55), speed: 1.2, padding: this.pad, essential: true });
      } else if (!id) {
        this.map.flyTo({ center: [this.campus.lng, this.campus.lat], zoom: 11.6, pitch: 55, speed: 1.1, padding: this.pad });
      }
    }

    // setCenter cancels running animations, so start following only after the fly-to ends
    _followAfterMove(id) {
      this.map.once('moveend', () => { if (this.selected === id) this.follow = true; });
    }

    _stopLabels() {
      this.stopMarks.forEach(m => m.remove()); this.stopMarks = [];
      const rid = this.selectedRoute || (this.selected && this.buses.get(this.selected)?.routeId);
      const r = rid && this.routes.find(x => x.id === rid); if (!r) return;
      r.stops.filter(s => !s.name.startsWith('IUBAT')).forEach(s => {
        const el = document.createElement('div'); el.className = 'stop-pill'; el.textContent = s.name; el.style.setProperty('--route', r.color);
        this.stopMarks.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -10] }).setLngLat([s.lng, s.lat]).addTo(this.map));
      });
    }

    setPadding(bottom) { this.pad = { top: 0, bottom, left: 0, right: 0 }; this.map.setPadding(this.pad); }
    isTop() { return this.map.getPitch() < 20; }
    setView(mode) { this._ease({ pitch: mode === 'top' ? 0 : 60, duration: 600 }); }
    rotate(deg) { this._ease({ bearing: this.map.getBearing() + deg, duration: 500 }); }
    zoom(f) { this._ease({ zoom: this.map.getZoom() + (f < 1 ? 1 : -1), duration: 300 }); }
    // Following a bus moves the camera every frame, which would cancel these animations: pause it, then resume.
    _ease(opts) {
      const id = this.follow && this.selected;
      this.follow = false;
      if (id) { const e = this.buses.get(id); if (e) opts.center = [e.lng, e.lat]; this._followAfterMove(id); }
      this.map.easeTo(opts);
    }
    recenter() {
      const e = this.selected && this.buses.get(this.selected);
      this.follow = false;
      if (e) this._followAfterMove(this.selected);
      this.map.easeTo({ center: e ? [e.lng, e.lat] : [this.campus.lng, this.campus.lat], duration: 600 });
    }
    resize() { this.map.resize(); }
  }
  window.BusMap = BusMap;
})();
