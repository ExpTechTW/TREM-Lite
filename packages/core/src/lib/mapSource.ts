/** GeoJSON source writes that skip the ones that would change nothing. */
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

/** What each source was last given, keyed by the source object itself. */
const sent = new WeakMap<GeoJSONSource, string>();

/**
 * `setData` a point source, unless it would receive exactly what it holds.
 *
 * Every `setData` reloads the source's tiles on a worker and marks label
 * placement stale, and the RTS frame re-sent unchanged — usually empty — data
 * to four sources every second: enough on its own to keep the map redrawing
 * about eighteen frames a second while nothing happened. The signature covers
 * everything a layer can read from a point: its position and its properties.
 *
 * Only correct while every write to a source goes through here; one that
 * bypasses it would leave the remembered signature stale.
 */
export function setPoints(map: MlMap, id: string, features: GeoJSON.Feature<GeoJSON.Point>[]): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (!source) return;
  let signature = "";
  for (const f of features) {
    signature += `${f.geometry.coordinates.join(",")}${JSON.stringify(f.properties)};`;
  }
  if (sent.get(source) === signature) return;
  sent.set(source, signature);
  source.setData({ type: "FeatureCollection", features });
}
