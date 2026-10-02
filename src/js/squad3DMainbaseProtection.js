import * as THREE from "three";
import Squad3DSimulation from "./squad3DSimulation.js";

// UBG fork: draws the mainbase protection (MBC) zones in the 3D view. No upstream file is
// patched: we wrap Squad3DSimulation's _drawCapzones(), which upstream already calls on
// open/refresh and after a flag click in 3D. Zone state comes from squadMainbaseProtection.js.

const SEGMENTS = 20; // per 300m cell side, enough to follow the terrain
const GROUND_OFFSET = 3; // meters above the terrain, avoids z-fighting

const fillMaterial = new THREE.MeshBasicMaterial({
    color: 0x0066ff, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0066ff, transparent: true, opacity: 0.6 });

const proto = Squad3DSimulation.prototype;
const drawCapzones = proto._drawCapzones;

if (typeof drawCapzones !== "function") {
    console.warn("[UBG] Squad3DSimulation._drawCapzones not found, MBC zones won't show in 3D (upstream renamed it?)");
} else {
    proto._drawCapzones = function (layer, activeMap) {
        drawCapzones.call(this, layer, activeMap);
        drawMainbaseProtections(this, layer, activeMap);
    };
}


/**
 * @param {Squad3DSimulation} sim
 * @param {?SquadLayer} layer
 * @param {object} activeMap
 */
function drawMainbaseProtections(sim, layer, activeMap) {
    if (!sim._ubgMbcGroup) {
        sim._ubgMbcGroup = new THREE.Group();
        sim.scene.add(sim._ubgMbcGroup);
    }
    const group = sim._ubgMbcGroup;
    group.children.forEach((obj) => obj.geometry.dispose());
    group.clear();

    const corner0 = activeMap?.SDK_data?.minimap?.corner0;
    if (!layer?.mainbaseProtections || !corner0) return;

    // Height of the ground at a world X/Z, same mapping as squad3DSimulation.js
    const groundY = (x, z) => sim.terrainHeightAt(x / sim.terrainSize + 0.5, z / sim.terrainSize + 0.5) + GROUND_OFFSET;

    // In activeLayerMarkers = setting on and not hidden by the flag rules
    layer.mainbaseProtections
        .filter(({ protection }) => layer.activeLayerMarkers.hasLayer(protection))
        .flatMap(({ protection }) => protection.cellBounds())
        .forEach((bounds) => {
            const nw = sim._latLngToWorldXZ(bounds.getNorth(), bounds.getWest(), layer.map, corner0);
            const se = sim._latLngToWorldXZ(bounds.getSouth(), bounds.getEast(), layer.map, corner0);
            const [x0, x1] = [Math.min(nw.x, se.x), Math.max(nw.x, se.x)];
            const [z0, z1] = [Math.min(nw.z, se.z), Math.max(nw.z, se.z)];

            const plane = new THREE.PlaneGeometry(x1 - x0, z1 - z0, SEGMENTS, SEGMENTS);
            plane.rotateX(-Math.PI / 2);
            plane.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
            const pos = plane.attributes.position;
            for (let i = 0; i < pos.count; i++) pos.setY(i, groundY(pos.getX(i), pos.getZ(i)));
            plane.computeBoundingSphere();
            group.add(new THREE.Mesh(plane, fillMaterial));

            // Cell outline following the ground, so the keypad grid stays readable
            const outline = [];
            const edges = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
            for (const [ax, az, bx, bz] of edges) {
                for (let s = 0; s < SEGMENTS; s++) {
                    const x = ax + (bx - ax) * s / SEGMENTS;
                    const z = az + (bz - az) * s / SEGMENTS;
                    outline.push(new THREE.Vector3(x, groundY(x, z), z));
                }
            }
            group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(outline), lineMaterial));
        });
}
