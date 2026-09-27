/** GeoJSON source writes that skip the ones that would change nothing. */
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

const TOWNS = { source: "map", sourceLayer: "town" } as const;
/** The towns paintTowns last coloured, so an unchanged colouring costs nothing. */
let painted = "";

/**
 * Colour towns by code — the EEW's predicted area, an intensity or a
 * long-period report — or, with null, return them all to the base colour.
 *
 * Feature state, not a new `fill-color` expression: a data-driven paint
 * property changed makes MapLibre re-tile the whole basemap source on its
 * workers (every layer of it, not only the towns), where feature state only
 * updates the colours of the tiles already loaded. The town layer reads the
 * state (map.ts, `promoteId` on the town code).
 */
export function paintTowns(map: MlMap, colors: Record<number, string> | null): void {
  const signature = colors ? JSON.stringify(colors) : "";
  if (signature === painted) return;
  painted = signature;
  map.removeFeatureState(TOWNS);
  for (const [code, color] of Object.entries(colors ?? {})) {
    map.setFeatureState({ ...TOWNS, id: Number(code) }, { color });
  }
}

/** What each source was last given, keyed by the source object itself. */
const sent = new WeakMap<GeoJSONSource, string>();

/**
 * `setData` a source, unless it would receive exactly what it already holds.
 *
 * Every `setData` reloads the source's tiles on a worker and marks label
 * placement stale, and the RTS frame alone re-sent unchanged — usually empty —
 * data to four sources every second: enough on its own to keep the map
 * redrawing about eighteen frames a second while nothing happened. The
 * serialized features are the signature, so any change at all still goes out.
 *
 * Only correct while every write to a source goes through here; one that
 * bypasses it would leave the remembered signature stale.
 */
export function setFeatures(map: MlMap, id: string, features: GeoJSON.Feature[]): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (!source) return;
  const signature = JSON.stringify(features);
  if (sent.get(source) === signature) return;
  sent.set(source, signature);
  source.setData({ type: "FeatureCollection", features });
}

/**
 * `setData` without the comparison, for data that changes on every write —
 * a wavefront whose radius grows each tick — where building the signature
 * would cost more than it saves. It forgets the source's signature, so a
 * `setFeatures` to the same source afterwards still compares correctly.
 */
export function replaceFeatures(map: MlMap, id: string, features: GeoJSON.Feature[]): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (!source) return;
  sent.delete(source);
  source.setData({ type: "FeatureCollection", features });
}
