/** GeoJSON source writes that skip the ones that would change nothing. */
import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

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
