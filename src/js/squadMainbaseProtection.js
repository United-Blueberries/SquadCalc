import { Polyline, Rectangle, FeatureGroup, LatLngBounds, LatLng } from "leaflet";
import { App } from "../app.js";

// UBG fork: mainbase protection (MBC) zones. Everything lives in this file so upstream
// syncs only touch the few `// UBG` hooks in squadLayer/squadObjective/squadSettings.

// Maps with a 3x3 protection grid, every other map uses 5x5
const GRID_3X3 = new Set([
    "Belaya", "Chora", "Fallujah", "FoolsRoad", "Harju", "Kamdesh", "Kohat", "Kokan",
    "Logar", "Mestia", "Mutaha", "Narva", "Narva_f", "Pacific", "Sumari",
]);

/**
 * Manages mainbase protection visualization with exclusion zones
 * Displays a grid-based protection area around a mainbase that can be reduced by flag exclusions
 */
export class SquadMainbaseProtection extends FeatureGroup {
    /**
     * @param {L.LatLng} mainbaseLatLng - Center point of the mainbase
     * @param {number} gridSize - Size of protection area in grid squares (3 or 5)
     * @param {number} gameToMapScale - Conversion factor from game coordinates to map pixels
     * @param {number} gameToMapScaleY - Y-axis conversion factor (may differ from X)
     * @param {string} teamColor - Color for protection zone visualization
     * @param {L.Map} map - Leaflet map instance
     */
    constructor(mainbaseLatLng, gridSize, gameToMapScale, gameToMapScaleY, teamColor, map) {
        super();
        
        // Normalize coordinates: accept both array [lat, lng] and LatLng objects
        let normalizedLatLng;
        if (!mainbaseLatLng) {
            console.warn("SquadMainbaseProtection: No mainbaseLatLng provided");
            return;
        } else if (Array.isArray(mainbaseLatLng)) {
            // Validate array elements BEFORE creating LatLng (Leaflet throws on NaN during construction)
            if (!isFinite(mainbaseLatLng[0]) || !isFinite(mainbaseLatLng[1])) {
                console.warn(`SquadMainbaseProtection: Invalid mainbaseLatLng array values: lat=${mainbaseLatLng[0]}, lng=${mainbaseLatLng[1]}`);
                return;
            }
            // Convert array [lat, lng] to LatLng object
            normalizedLatLng = new LatLng(mainbaseLatLng[0], mainbaseLatLng[1]);
        } else if (mainbaseLatLng.lat !== undefined && mainbaseLatLng.lng !== undefined) {
            // Already a LatLng object - validate it
            if (!isFinite(mainbaseLatLng.lat) || !isFinite(mainbaseLatLng.lng)) {
                console.warn(`SquadMainbaseProtection: Invalid LatLng object: lat=${mainbaseLatLng.lat}, lng=${mainbaseLatLng.lng}`);
                return;
            }
            normalizedLatLng = mainbaseLatLng;
        } else {
            console.warn("SquadMainbaseProtection: Invalid mainbaseLatLng format provided");
            return;
        }
        
        if (!isFinite(gameToMapScale) || !isFinite(gameToMapScaleY) || gameToMapScale === 0 || gameToMapScaleY === 0) {
            console.warn(`SquadMainbaseProtection: Invalid scale factors: gameToMapScale=${gameToMapScale}, gameToMapScaleY=${gameToMapScaleY}`);
            return;
        }
        
        this.mainbaseLatLng = normalizedLatLng;
        this.gridSize = gridSize;
        this.gameToMapScale = gameToMapScale;
        this.gameToMapScaleY = gameToMapScaleY;
        this.teamColor = teamColor;
        this.map = map;
        
        // 300m per grid square (Squad game standard)
        this.gridSquareSize = 300;
        
        // Calculate the center of the 300m grid square containing the mainbase
        // This becomes the (0,0) reference point for the protection grid
        this.centerSquareLatlng = this._calculateCenterSquare();
        if (!this.centerSquareLatlng) {
            console.warn("SquadMainbaseProtection: Failed to calculate center square, aborting initialization");
            return;
        }
        
        // Track permanent exclusions (applied when flag is selected)
        this.activeExclusions = new Map();
        
        // Track preview exclusion (temporary hover preview)
        this._previewExclusionCoords = null;
        
        // Container for grid protection zones (gets cleared and redrawn frequently)
        this.protectionLayers = new FeatureGroup();
        this.addLayer(this.protectionLayers);
        
        // Container for boundary layer (separate so it doesn't get hidden)
        this.boundaryLayer = new FeatureGroup();
        this.addLayer(this.boundaryLayer);
        
        // Track zoom state to avoid re-rendering during animation
        this._isZooming = false;
        
        // Initial render (wrapped in try-catch for safety)
        try {
            this._renderProtection();
            this._drawOuterBoundary();
        } catch (e) {
            console.error("Error rendering protection zones:", e);
        }
        
        this._onZoomStart = () => { this._isZooming = true; };
        this._onZoomEnd = () => { this._isZooming = false; this.refresh(); };
        this._onMoveEnd = () => this.refresh();
    }

    // Refresh on zoom/move only while on the map, so removed protections don't keep listening
    onAdd(map) {
        super.onAdd(map);
        map.on("zoomstart", this._onZoomStart);
        map.on("zoomend", this._onZoomEnd);
        map.on("moveend", this._onMoveEnd);
        this.refresh();
    }

    onRemove(map) {
        map.off("zoomstart", this._onZoomStart);
        map.off("zoomend", this._onZoomEnd);
        map.off("moveend", this._onMoveEnd);
        this._isZooming = false;
        super.onRemove(map);
    }

    /**
     * Calculate the center of the 300m grid square containing the mainbase
     * The mainbase flag is inside one of the map's 300m squares.
     * The CENTER of that square becomes the (0,0) reference point.
     * @returns {L.LatLng} The center of the containing grid square
     */
    _calculateCenterSquare() {
        try {
            // Size of a grid square in map coordinates
            const squareSizeX = this.gridSquareSize * Math.abs(this.gameToMapScale);
            const squareSizeY = this.gridSquareSize * Math.abs(this.gameToMapScaleY);
            
            if (!isFinite(squareSizeX) || !isFinite(squareSizeY)) {
                console.error(`SquadMainbaseProtection: Invalid square sizes: X=${squareSizeX}, Y=${squareSizeY}`);
                return null;
            }
            
            // Find which grid square contains the mainbase by discretizing to grid boundaries
            // Determine the grid square boundaries that contain mainbase.lng
            const gridSquareMinLng = Math.floor(this.mainbaseLatLng.lng / squareSizeX) * squareSizeX;
            const gridSquareMinLat = Math.floor(this.mainbaseLatLng.lat / squareSizeY) * squareSizeY;
            
            // Calculate the center of the containing square
            const centerLng = gridSquareMinLng + (squareSizeX / 2);
            const centerLat = gridSquareMinLat + (squareSizeY / 2);
            
            if (!isFinite(centerLat) || !isFinite(centerLng)) {
                console.error(`SquadMainbaseProtection: Invalid center square coordinates: lat=${centerLat}, lng=${centerLng}`);
                return null;
            }
            
            return new LatLng(centerLat, centerLng);
        } catch (e) {
            console.error("SquadMainbaseProtection: Error calculating center square:", e);
            return null;
        }
    }

    /**
     * Calculate the bounds of a single 300m grid square
     * @param {number} gridX - X coordinate in grid squares
     * @param {number} gridY - Y coordinate in grid squares
     * @returns {L.LatLngBounds} Bounds of the grid square
     */
    _getGridSquareBounds(gridX, gridY) {
        // Calculate square size in map coordinates
        const squareSizeX = this.gridSquareSize * Math.abs(this.gameToMapScale);
        const squareSizeY = this.gridSquareSize * Math.abs(this.gameToMapScaleY);
        
        // Calculate center of this grid square relative to center square (0,0)
        const centerLng = this.centerSquareLatlng.lng + (gridX * squareSizeX);
        const centerLat = this.centerSquareLatlng.lat + (gridY * squareSizeY);
        
        // Validate we don't have NaN values
        if (!isFinite(centerLat) || !isFinite(centerLng)) {
            console.warn(`Invalid center coordinates for grid square [${gridX}, ${gridY}]: lat=${centerLat}, lng=${centerLng}`);
            return null;
        }
        
        const halfSquareX = squareSizeX / 2;
        const halfSquareY = squareSizeY / 2;
        
        const nw = new LatLng(centerLat + halfSquareY, centerLng - halfSquareX);
        const se = new LatLng(centerLat - halfSquareY, centerLng + halfSquareX);
        
        return new LatLngBounds(nw, se);
    }

    /**
     * Get the grid coordinates (grid square indices) covered by protection
     * @returns {Array<[number, number]>} Array of [gridX, gridY] coordinates
     */
    _getProtectionGridCoordinates() {
        const radius = Math.floor(this.gridSize / 2); // 1 for 3x3, 2 for 5x5
        const coords = [];
        
        for (let x = -radius; x <= radius; x++) {
            for (let y = -radius; y <= radius; y++) {
                coords.push([x, y]);
            }
        }
        
        return coords;
    }

    /**
     * Check if a grid square is visible on the current map viewport
     * @param {L.LatLngBounds} squareBounds - Bounds of the grid square
     * @returns {boolean} True if square is (at least partially) visible
     */
    _isSquareVisible(squareBounds) {
        // Only draw squares that are on visible map
        // This is an optimization to skip drawing off-map squares
        const mapBounds = this.map.getBounds();
        return squareBounds.intersects(mapBounds);
    }

    /**
     * Get the center point of a grid square
     * @param {number} gridX - X coordinate in grid squares
     * @param {number} gridY - Y coordinate in grid squares
     * @returns {L.LatLng|null} Center point or null if invalid
     */
    _getGridSquareCenter(gridX, gridY) {
        const squareSizeX = this.gridSquareSize * Math.abs(this.gameToMapScale);
        const squareSizeY = this.gridSquareSize * Math.abs(this.gameToMapScaleY);
        
        const centerLat = this.centerSquareLatlng.lat + (gridY * squareSizeY);
        const centerLng = this.centerSquareLatlng.lng + (gridX * squareSizeX);
        
        // Validate coordinates
        if (!isFinite(centerLat) || !isFinite(centerLng)) {
            return null;
        }
        
        return new LatLng(centerLat, centerLng);
    }

    /**
     * Calculate which grid squares are affected by a flag exclusion
     * Exclusion is 3x3 around the flag location
     * @param {L.LatLng} flagLatLng - Location of the flag
     * @returns {Set<string>} Set of grid coordinate strings ("x,y") affected by exclusion
     */
    _getExclusionGridCoordinates(flagLatLng) {
        try {
            // Find which grid square the flag is in, using center square as reference
            const squareSizeX = this.gridSquareSize * Math.abs(this.gameToMapScale);
            const squareSizeY = this.gridSquareSize * Math.abs(this.gameToMapScaleY);
            
            // Calculate relative position from center square
            const relLng = flagLatLng.lng - this.centerSquareLatlng.lng;
            const relLat = flagLatLng.lat - this.centerSquareLatlng.lat;
            
            // Find which grid square contains the flag by discretizing to grid boundaries
            const flagGridX = Math.floor(relLng / squareSizeX + 0.5); // Round to nearest grid square
            const flagGridY = Math.floor(relLat / squareSizeY + 0.5);
            
            // 3x3 area around flag = 1 square radius
            const exclusionCoords = new Set();
            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    exclusionCoords.add(`${flagGridX + x},${flagGridY + y}`);
                }
            }
            
            return exclusionCoords;
        } catch (e) {
            console.error("Error calculating exclusion grid coordinates:", e);
            return new Set();
        }
    }

    /**
     * Check if a grid coordinate is excluded
     * @param {number} gridX - X coordinate
     * @param {number} gridY - Y coordinate
     * @returns {boolean} True if this square is excluded
     */
    _isCoordinateExcluded(gridX, gridY) {
        const coordKey = `${gridX},${gridY}`;
        
        // Check all active exclusions
        for (const exclusionSet of this.activeExclusions.values()) {
            if (exclusionSet.has(coordKey)) {
                return true;
            }
        }
        
        // Check preview exclusion
        if (this._previewExclusionCoords && this._previewExclusionCoords.has(coordKey)) {
            return true;
        }
        
        return false;
    }

    /**
     * Render the protection zone with solid fill and exclusion holes
     * @private
     */
    _renderProtection() {
        try {
            // Skip rendering during zoom animation to avoid visual glitches
            if (this._isZooming) {
                return;
            }
            
            // Guard against invalid state
            if (!this.protectionLayers || !this.mainbaseLatLng || !isFinite(this.gameToMapScale) || !isFinite(this.gameToMapScaleY)) {
                return; // Skip rendering if in invalid state
            }

            // Clear existing layers to start fresh
            this.protectionLayers.clearLayers();
            
            const protectionCoords = this._getProtectionGridCoordinates();
            const activelyExcludedCoords = new Set();
            
            // Collect permanently excluded coordinates (from selected flags)
            for (const exclusionSet of this.activeExclusions.values()) {
                for (const coord of exclusionSet) {
                    activelyExcludedCoords.add(coord);
                }
            }
            
            // Draw solid protection zones (excluding areas from selected flags)
            protectionCoords.forEach(([gridX, gridY]) => {
                const coordKey = `${gridX},${gridY}`;
                if (activelyExcludedCoords.has(coordKey)) {
                    return; // Skip excluded squares from active flags
                }
                
                const bounds = this._getGridSquareBounds(gridX, gridY);
                if (!bounds || !this._isSquareVisible(bounds)) {
                    return; // Skip invalid or off-map squares for performance
                }
                
                const rectangle = new Rectangle(bounds, {
                    color: "#0066ff",
                    fillColor: "#0066ff",
                    opacity: 0.2,
                    fillOpacity: 0.15,
                    weight: 1,
                    dashArray: undefined,
                });
                this.protectionLayers.addLayer(rectangle);
            });
            
            // Draw dotted outlines around preview exclusion only (on hover)
            if (this._previewExclusionCoords && this._previewExclusionCoords.size > 0) {
                this._drawExclusionOutlines(this._previewExclusionCoords);
            }
        } catch (e) {
            console.error("Error rendering protection zones:", e);
        }
    }

    /**
     * Draw dotted outlines around exclusion areas
     * @private
     */
    _drawExclusionOutlines(excludedCoords) {
        try {
            excludedCoords.forEach((coordKey) => {
                const [gridX, gridY] = coordKey.split(",").map(Number);
                const bounds = this._getGridSquareBounds(gridX, gridY);
                
                if (!bounds || !this._isSquareVisible(bounds)) {
                    return;
                }
                
                const rectangle = new Rectangle(bounds, {
                    color: "#ff6600",
                    fillColor: undefined,
                    opacity: 0.9,
                    fillOpacity: 0,
                    weight: 2.5,
                    dashArray: "6, 3",
                });
                this.protectionLayers.addLayer(rectangle);
            });
        } catch (e) {
            console.error("Error drawing exclusion outlines:", e);
        }
    }

    /**
     * Draw outer boundary of entire protection area with dotted line
     * Rendered separately so it's always visible and not hidden by exclusion zones
     * @private
     */
    _drawOuterBoundary() {
        try {
            // Skip during zoom animation
            if (this._isZooming) {
                return;
            }
            
            // Clear existing boundary
            this.boundaryLayer.clearLayers();
            
            const radius = Math.floor(this.gridSize / 2);
            const corners = [
                [-radius - 0.5, -radius - 0.5],
                [radius + 0.5, -radius - 0.5],
                [radius + 0.5, radius + 0.5],
                [-radius - 0.5, radius + 0.5],
                [-radius - 0.5, -radius - 0.5],
            ];
            
            const latLngs = corners
                .map(([gridX, gridY]) => this._getGridSquareCenter(gridX, gridY))
                .filter(latlng => latlng !== null); // Filter out invalid coordinates
            
            if (latLngs.length === 0) {
                return; // No valid coordinates to draw
            }
            
            const boundary = new Polyline(latLngs, {
                color: "#0066ff",
                opacity: 0.5,
                weight: 3.5,
                dashArray: "5, 10",
            });
            
            this.boundaryLayer.addLayer(boundary);
        } catch (e) {
            console.error("Error drawing outer boundary:", e);
        }
    }

    /**
     * Normalize flag coordinates - accepts both array [lat, lng] and LatLng objects
     * @param {Array|L.LatLng} flagCoords - Flag coordinates in any format
     * @returns {L.LatLng|null} - Normalized LatLng or null if invalid
     */
    _normalizeCoordinates(flagCoords) {
        if (!flagCoords) return null;
        
        if (Array.isArray(flagCoords)) {
            const normalized = new LatLng(flagCoords[0], flagCoords[1]);
            if (isFinite(normalized.lat) && isFinite(normalized.lng)) return normalized;
            return null;
        } else if (flagCoords.lat !== undefined && flagCoords.lng !== undefined) {
            if (isFinite(flagCoords.lat) && isFinite(flagCoords.lng)) return flagCoords;
            return null;
        }
        return null;
    }

    /**
     * Preview an exclusion area (shown on flag hover, not permanent)
     * @param {L.LatLng|Array} flagLatLng - Location of the flag
     */
    previewExclusion(flagLatLng) {
        try {
            const normalizedFlag = this._normalizeCoordinates(flagLatLng);
            if (!normalizedFlag) {
                console.warn("Invalid flagLatLng for previewExclusion");
                return;
            }
            this._previewExclusionCoords = this._getExclusionGridCoordinates(normalizedFlag);
            this._renderProtection();
        } catch (e) {
            console.error("Error previewing exclusion:", e);
        }
    }

    /**
     * Clear the preview exclusion
     */
    clearPreview() {
        this._previewExclusionCoords = null;
        this._renderProtection();
    }

    /**
     * Permanently apply an exclusion (when a flag is selected)
     * @param {L.LatLng|Array} flagLatLng - Location of the flag
     */
    /**
     * Apply exclusion without immediately rendering
     * @private
     */
    _applyExclusionSilent(flagLatLng) {
        try {
            const normalizedFlag = this._normalizeCoordinates(flagLatLng);
            if (!normalizedFlag) {
                console.warn("Invalid flagLatLng for _applyExclusionSilent");
                return;
            }
            const exclusionKey = `${normalizedFlag.lat},${normalizedFlag.lng}`;
            const exclusionSet = this._getExclusionGridCoordinates(normalizedFlag);
            this.activeExclusions.set(exclusionKey, exclusionSet);
            this._previewExclusionCoords = null;
            // DO NOT call _renderProtection() - caller will handle rendering
        } catch (e) {
            console.error("Error applying exclusion (silent):", e);
        }
    }

    applyExclusion(flagLatLng) {
        this._applyExclusionSilent(flagLatLng);
        this._renderProtection();
    }

    /**
     * Remove a specific exclusion
     * @param {L.LatLng|Array} flagLatLng - Location of the flag
     */
    removeExclusion(flagLatLng) {
        try {
            const normalizedFlag = this._normalizeCoordinates(flagLatLng);
            if (!normalizedFlag) {
                console.warn("Invalid flagLatLng for removeExclusion");
                return;
            }
            const exclusionKey = `${normalizedFlag.lat},${normalizedFlag.lng}`;
            this.activeExclusions.delete(exclusionKey);
            this._renderProtection();
        } catch (e) {
            console.error("Error removing exclusion:", e);
        }
    }

    /**
     * Clear all applied exclusions without rendering
     * @private
     */
    _clearAllExclusionsSilent() {
        this.activeExclusions.clear();
        this._previewExclusionCoords = null;
    }

    /**
     * Clear all applied exclusions
     */
    clearAllExclusions() {
        this._clearAllExclusionsSilent();
        this._renderProtection();
    }

    /**
     * Refresh rendering (call when map moves or zooms)
     */
    refresh() {
        this._renderProtection();
        this._drawOuterBoundary();
    }
}


/**
 * Create a protection zone around each main of the layer
 * @param {SquadLayer} layer
 */
export function createMainbaseProtections(layer) {
    const gridSize = GRID_3X3.has(layer.map.activeMap?.name) ? 3 : 5;
    layer.mainbaseProtections = [];

    layer.mains.forEach((mainbase) => {
        const protection = new SquadMainbaseProtection(
            mainbase.latlng,
            gridSize,
            layer.map.gameToMapScale,
            layer.map.gameToMapScaleY,
            App.mainColor,
            layer.map
        );
        // The constructor returns early (without centerSquareLatlng) on invalid input
        if (!protection.centerSquareLatlng) return;
        layer.mainbaseProtections.push({ protection, mainbase });
    });

    toggleMainbaseProtections(layer, App.userSettings.mainbaseProtection);
}


/**
 * Sync protections with the confirmed flags: the deepest confirmed flag cuts its 3x3
 * exclusion out of both zones. The attacker's zone is dropped while the first flag is
 * the deepest one, the defender's once the last flag before their main is confirmed.
 * @param {SquadLayer} layer
 */
export function updateMainbaseProtections(layer) {
    if (!layer.mainbaseProtections?.length || !App.userSettings.mainbaseProtection) return;

    // A confirmation without a depth (null) is further along than any pinned one
    const depthOf = (flag) => layer.confirmedStep.get(flag) ?? Infinity;
    let deepest = null;
    layer.selectedFlags.forEach((flag) => {
        if (!flag.isMain && (!deepest || depthOf(flag) > depthOf(deepest))) deepest = flag;
    });
    const depth = deepest ? depthOf(deepest) : 0;
    const attacker = layer.perspectiveMain;
    const defender = attacker ? layer._farMain() : null;

    layer.mainbaseProtections.forEach(({ protection, mainbase }) => {
        const hidden = (mainbase === attacker && depth === 1) ||
            (mainbase === defender && depth === layer.solver?.stepCount);

        if (hidden) {
            layer.activeLayerMarkers.removeLayer(protection);
            return;
        }

        protection._clearAllExclusionsSilent();
        if (deepest) protection._applyExclusionSilent(deepest.latlng);
        if (!layer.activeLayerMarkers.hasLayer(protection)) layer.activeLayerMarkers.addLayer(protection);
        protection._renderProtection();
    });
}


/**
 * @param {SquadLayer} layer
 * @param {boolean} visible
 */
export function toggleMainbaseProtections(layer, visible) {
    if (!visible) {
        layer.mainbaseProtections?.forEach(({ protection }) => layer.activeLayerMarkers.removeLayer(protection));
        return;
    }
    layer.mainbaseProtections?.forEach(({ protection }) => layer.activeLayerMarkers.addLayer(protection));
    updateMainbaseProtections(layer);
}


/**
 * Show/clear the exclusion a flag would cut out, while hovering it
 * @param {SquadObjective} flag
 * @param {boolean} show
 */
export function previewMainbaseExclusion(flag, show) {
    if (flag.isMain || !App.userSettings.mainbaseProtection) return;
    flag.layer.mainbaseProtections?.forEach(({ protection }) => {
        if (show) protection.previewExclusion(flag.latlng);
        else protection.clearPreview();
    });
}
