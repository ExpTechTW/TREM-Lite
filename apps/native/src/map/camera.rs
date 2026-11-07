//! The map's camera: Web Mercator with a 512 px world at zoom 0, as MapLibre's, no
//! rotation or tilt. `fit_bounds` and the flight it starts follow MapLibre's
//! `cameraForBounds` and `flyTo` (van Wijk's optimal path), since focus.ts is written
//! against what those do.

const TILE_SIZE: f64 = 512.0;
const MAX_LAT: f64 = 85.051129;

pub const MIN_ZOOM: f64 = 4.0;
pub const MAX_ZOOM: f64 = 12.0;

/// Mercator x in 0..1.
pub fn merc_x(lon: f64) -> f64 {
    (lon + 180.0) / 360.0
}

/// Mercator y in 0..1, north at 0.
pub fn merc_y(lat: f64) -> f64 {
    let lat = lat.clamp(-MAX_LAT, MAX_LAT);
    let sin = (lat.to_radians()).sin();
    0.5 - ((1.0 + sin) / (1.0 - sin)).ln() / (4.0 * std::f64::consts::PI)
}

pub fn lon_of(x: f64) -> f64 {
    x * 360.0 - 180.0
}

pub fn lat_of(y: f64) -> f64 {
    let n = std::f64::consts::PI * (1.0 - 2.0 * y);
    n.sinh().atan().to_degrees()
}

fn world(zoom: f64) -> f64 {
    TILE_SIZE * 2f64.powf(zoom)
}

/// Padding in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Padding {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

impl Padding {
    pub fn all(p: f64) -> Self {
        Self {
            top: p,
            bottom: p,
            left: p,
            right: p,
        }
    }
}

/// The west, south, east and north of a set of points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl Bounds {
    pub fn around(points: impl IntoIterator<Item = (f64, f64)>) -> Option<Self> {
        let mut out: Option<Self> = None;
        for (lon, lat) in points {
            let b = out.get_or_insert(Self {
                west: lon,
                south: lat,
                east: lon,
                north: lat,
            });
            b.west = b.west.min(lon);
            b.east = b.east.max(lon);
            b.south = b.south.min(lat);
            b.north = b.north.max(lat);
        }
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub lon: f64,
    pub lat: f64,
    pub zoom: f64,
}

/// The cubic-bezier(0.25, 0.1, 0.25, 1) MapLibre eases with.
fn default_easing(t: f64) -> f64 {
    const X1: f64 = 0.25;
    const Y1: f64 = 0.1;
    const X2: f64 = 0.25;
    const Y2: f64 = 1.0;
    let bezier = |a: f64, b: f64, s: f64| {
        let m = 1.0 - s;
        3.0 * m * m * s * a + 3.0 * m * s * s * b + s * s * s
    };
    let mut s = t;
    for _ in 0..8 {
        let x = bezier(X1, X2, s) - t;
        let m = 1.0 - s;
        let dx = 3.0 * m * m * X1 + 6.0 * m * s * (X2 - X1) + 3.0 * s * s * (1.0 - X2);
        if dx.abs() < 1e-6 {
            break;
        }
        s = (s - x / dx).clamp(0.0, 1.0);
    }
    bezier(Y1, Y2, s)
}

/// A flight in progress: `flyTo`'s path through (s, w(s), u(s)).
#[derive(Clone, Copy, Debug)]
struct Flight {
    start: (f64, f64),
    start_zoom: f64,
    delta: (f64, f64),
    end_zoom: f64,
    duration_ms: f64,
    began_ms: f64,
    s_total: f64,
    r0: f64,
    rho: f64,
    w0: f64,
    u1: f64,
    /// A flight with no ground to cover only changes scale.
    zoom_only: Option<f64>,
}

impl Flight {
    fn state(&self, k: f64) -> (f64, f64) {
        let s = k * self.s_total;
        match self.zoom_only {
            Some(sign) => {
                let w = (sign * self.rho * s).exp();
                (0.0, 1.0 / w)
            }
            None => {
                let rho2 = self.rho * self.rho;
                let w = self.r0.cosh() / (self.r0 + self.rho * s).cosh();
                let u = self.w0
                    * ((self.r0.cosh() * (self.r0 + self.rho * s).tanh() - self.r0.sinh()) / rho2)
                    / self.u1;
                (u, 1.0 / w)
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Camera {
    /// The centre in Mercator 0..1.
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
    /// Logical pixels.
    pub width: f64,
    pub height: f64,
    flight: Option<Flight>,
}

impl Camera {
    pub fn new(lon: f64, lat: f64, zoom: f64, width: f64, height: f64) -> Self {
        Self {
            x: merc_x(lon),
            y: merc_y(lat),
            zoom: zoom.clamp(MIN_ZOOM, MAX_ZOOM),
            width,
            height,
            flight: None,
        }
    }

    pub fn center(&self) -> (f64, f64) {
        (lon_of(self.x), lat_of(self.y))
    }

    pub fn resize(&mut self, width: f64, height: f64) {
        self.width = width;
        self.height = height;
    }

    pub fn is_moving(&self) -> bool {
        self.flight.is_some()
    }

    pub fn stop(&mut self) {
        self.flight = None;
    }

    /// World x, y (logical pixels from the world's corner) of a Mercator point at
    /// the current zoom, measured from the viewport's top left.
    pub fn to_screen(&self, mx: f64, my: f64) -> (f64, f64) {
        let w = world(self.zoom);
        (
            (mx - self.x) * w + self.width / 2.0,
            (my - self.y) * w + self.height / 2.0,
        )
    }

    pub fn screen_to_merc(&self, sx: f64, sy: f64) -> (f64, f64) {
        let w = world(self.zoom);
        (
            (sx - self.width / 2.0) / w + self.x,
            (sy - self.height / 2.0) / w + self.y,
        )
    }

    /// MapLibre's `cameraForBounds` at bearing 0. None when the padding leaves no room.
    pub fn for_bounds(&self, bounds: Bounds, padding: Padding, max_zoom: f64) -> Option<Target> {
        let z0 = world(self.zoom);
        let tl = (merc_x(bounds.west) * z0, merc_y(bounds.north) * z0);
        let br = (merc_x(bounds.east) * z0, merc_y(bounds.south) * z0);
        let size = (br.0 - tl.0, br.1 - tl.1);
        let scale_x = (self.width - padding.left - padding.right) / size.0;
        let scale_y = (self.height - padding.top - padding.bottom) / size.1;
        if scale_y < 0.0 || scale_x < 0.0 {
            return None;
        }
        let scale = scale_x.min(scale_y);
        let zoom = (self.zoom + scale.log2())
            .min(max_zoom.min(MAX_ZOOM))
            .max(MIN_ZOOM);
        // The padding's offset, in pixels at the final zoom.
        let offset_x = (padding.left - padding.right) / 2.0;
        let offset_y = (padding.top - padding.bottom) / 2.0;
        let w = world(zoom);
        let cx = (merc_x(bounds.west) + merc_x(bounds.east)) / 2.0 - offset_x / w;
        let cy = (merc_y(bounds.north) + merc_y(bounds.south)) / 2.0 - offset_y / w;
        Some(Target {
            lon: lon_of(cx),
            lat: lat_of(cy),
            zoom,
        })
    }

    pub fn jump(&mut self, target: Target) {
        self.flight = None;
        self.x = merc_x(target.lon);
        self.y = merc_y(target.lat);
        self.zoom = target.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
    }

    /// `flyTo` with a set duration. Zero jumps there.
    pub fn fly(&mut self, target: Target, duration_ms: f64, now_ms: f64) {
        if duration_ms <= 0.0 {
            self.jump(target);
            return;
        }
        let end = (merc_x(target.lon), merc_y(target.lat));
        let zoom = target.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        let rho: f64 = 1.42;
        let rho2 = rho * rho;
        let scale_of_zoom = 2f64.powf(zoom - self.zoom);
        let w0 = self.width.max(self.height);
        let w1 = w0 / scale_of_zoom;
        let w = world(self.zoom);
        let u1 = ((end.0 - self.x) * w).hypot((end.1 - self.y) * w);
        let zoom_out = |descent: bool| {
            let sign = if descent { -1.0 } else { 1.0 };
            let b = (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * u1 * u1)
                / (2.0 * (if descent { w1 } else { w0 }) * rho2 * u1);
            ((b * b + 1.0).sqrt() - b).ln()
        };
        let r0 = zoom_out(false);
        let mut s_total = (zoom_out(true) - r0) / rho;
        let mut zoom_only = None;
        if u1.abs() < 0.000002 || !s_total.is_finite() {
            if (w0 - w1).abs() < 0.000001 {
                self.jump(target);
                return;
            }
            let k = if w1 < w0 { -1.0 } else { 1.0 };
            s_total = (w1 / w0).ln().abs() / rho;
            zoom_only = Some(k);
        }
        self.flight = Some(Flight {
            start: (self.x, self.y),
            start_zoom: self.zoom,
            delta: (end.0 - self.x, end.1 - self.y),
            end_zoom: zoom,
            duration_ms,
            began_ms: now_ms,
            s_total,
            r0,
            rho,
            w0,
            u1,
            zoom_only,
        });
    }

    /// Advance a flight to `now_ms`. True while one is running.
    pub fn tick(&mut self, now_ms: f64) -> bool {
        let Some(flight) = self.flight else {
            return false;
        };
        let t = ((now_ms - flight.began_ms) / flight.duration_ms).clamp(0.0, 1.0);
        if t >= 1.0 {
            self.x = flight.start.0 + flight.delta.0;
            self.y = flight.start.1 + flight.delta.1;
            self.zoom = flight.end_zoom;
            self.flight = None;
            return false;
        }
        let k = default_easing(t);
        let (u, scale) = flight.state(k);
        self.zoom = flight.start_zoom + scale.log2();
        self.x = flight.start.0 + flight.delta.0 * u;
        self.y = flight.start.1 + flight.delta.1 * u;
        true
    }

    pub fn pan_by(&mut self, dx: f64, dy: f64) {
        let w = world(self.zoom);
        self.flight = None;
        self.x = (self.x - dx / w).rem_euclid(1.0);
        self.y = (self.y - dy / w).clamp(merc_y(MAX_LAT), merc_y(-MAX_LAT));
    }

    /// Zoom by `delta`, keeping the map under `(sx, sy)` where it is.
    pub fn zoom_at(&mut self, delta: f64, sx: f64, sy: f64) {
        self.flight = None;
        let (mx, my) = self.screen_to_merc(sx, sy);
        self.zoom = (self.zoom + delta).clamp(MIN_ZOOM, MAX_ZOOM);
        let w = world(self.zoom);
        self.x = mx - (sx - self.width / 2.0) / w;
        self.y = my - (sy - self.height / 2.0) / w;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn mercator_round_trips() {
        for (lon, lat) in [(121.6, 23.5), (118.0, 21.2), (-73.0, 40.7), (0.0, 0.0)] {
            assert!(close(lon_of(merc_x(lon)), lon, 1e-9));
            assert!(close(lat_of(merc_y(lat)), lat, 1e-9));
        }
        assert!(close(merc_x(0.0), 0.5, 1e-12));
        assert!(close(merc_y(0.0), 0.5, 1e-12));
    }

    #[test]
    fn the_centre_of_the_camera_is_the_middle_of_the_screen() {
        let cam = Camera::new(121.6, 23.5, 6.8, 1280.0, 815.0);
        let (sx, sy) = cam.to_screen(merc_x(121.6), merc_y(23.5));
        assert!(close(sx, 640.0, 1e-6) && close(sy, 407.5, 1e-6));
        let (mx, my) = cam.screen_to_merc(100.0, 50.0);
        let (bx, by) = cam.to_screen(mx, my);
        assert!(close(bx, 100.0, 1e-6) && close(by, 50.0, 1e-6));
    }

    /// `map.cameraForBounds([[118, 21.2], [124, 25.8]], {padding: 20})` on a 1280×815
    /// map in MapLibre 5.24 fits on the width of the screen less 40 px.
    #[test]
    fn fitting_taiwan_matches_the_formula_of_maplibre() {
        let cam = Camera::new(121.6, 23.5, 6.8, 1280.0, 815.0);
        let bounds = Bounds {
            west: 118.0,
            south: 21.2,
            east: 124.0,
            north: 25.8,
        };
        let t = cam
            .for_bounds(bounds, Padding::all(20.0), MAX_ZOOM)
            .unwrap();
        let world0 = 512.0;
        let span_x = (merc_x(124.0) - merc_x(118.0)) * world0;
        let span_y = (merc_y(21.2) - merc_y(25.8)) * world0;
        let want = ((1280.0 - 40.0) / span_x)
            .min((815.0 - 40.0) / span_y)
            .log2();
        assert!(close(t.zoom, want, 1e-9), "{} vs {want}", t.zoom);
        assert!(close(t.lon, 121.0, 1e-9));
        // Symmetric padding leaves the centre on the bounds' Mercator middle.
        let mid = (merc_y(25.8) + merc_y(21.2)) / 2.0;
        assert!(close(merc_y(t.lat), mid, 1e-12));
    }

    #[test]
    fn uneven_padding_shifts_the_centre_and_max_zoom_caps_it() {
        let cam = Camera::new(121.6, 23.5, 6.8, 1000.0, 800.0);
        let bounds = Bounds {
            west: 121.0,
            south: 24.0,
            east: 121.0001,
            north: 24.0001,
        };
        let pad = Padding {
            top: 150.0,
            bottom: 150.0,
            left: 300.0,
            right: 100.0,
        };
        let t = cam.for_bounds(bounds, pad, 8.0).unwrap();
        assert!(close(t.zoom, 8.0, 1e-12));
        let (sx, _) = {
            let mut c = cam.clone();
            c.jump(t);
            c.to_screen(merc_x(121.00005), merc_y(24.00005))
        };
        // The point lands in the middle of the space the padding leaves: 300..900.
        assert!(close(sx, 600.0, 1e-6), "{sx}");
    }

    #[test]
    fn padding_with_no_room_gives_nothing() {
        let cam = Camera::new(121.6, 23.5, 6.8, 200.0, 200.0);
        let bounds = Bounds {
            west: 120.0,
            south: 22.0,
            east: 122.0,
            north: 25.0,
        };
        assert!(cam.for_bounds(bounds, Padding::all(150.0), 8.0).is_none());
    }

    #[test]
    fn a_flight_starts_where_it_is_and_lands_on_target() {
        let mut cam = Camera::new(121.0, 23.5, 7.0, 1280.0, 815.0);
        let target = Target {
            lon: 121.6,
            lat: 24.0,
            zoom: 8.0,
        };
        cam.fly(target, 500.0, 1000.0);
        assert!(cam.is_moving());
        assert!(cam.tick(1000.0));
        assert!(close(cam.zoom, 7.0, 1e-6));
        assert!(cam.tick(1250.0));
        assert!(!cam.tick(1500.0));
        assert!(!cam.is_moving());
        let (lon, lat) = cam.center();
        assert!(close(lon, 121.6, 1e-9) && close(lat, 24.0, 1e-9));
        assert!(close(cam.zoom, 8.0, 1e-12));
    }

    #[test]
    fn a_flight_to_the_same_place_at_another_zoom_only_scales() {
        let mut cam = Camera::new(121.0, 23.5, 7.0, 1280.0, 815.0);
        let (lon, lat) = cam.center();
        cam.fly(
            Target {
                lon,
                lat,
                zoom: 9.0,
            },
            500.0,
            0.0,
        );
        assert!(cam.tick(250.0));
        assert!(cam.zoom > 7.0 && cam.zoom < 9.0);
        assert!(!cam.tick(500.0));
        assert!(close(cam.zoom, 9.0, 1e-12));
    }

    #[test]
    fn duration_zero_is_a_jump() {
        let mut cam = Camera::new(121.0, 23.5, 7.0, 1280.0, 815.0);
        cam.fly(
            Target {
                lon: 120.0,
                lat: 23.0,
                zoom: 6.0,
            },
            0.0,
            0.0,
        );
        assert!(!cam.is_moving());
        assert!(close(cam.zoom, 6.0, 1e-12));
    }

    #[test]
    fn zooming_keeps_the_point_under_the_cursor() {
        let mut cam = Camera::new(121.0, 23.5, 7.0, 1000.0, 800.0);
        let before = cam.screen_to_merc(200.0, 300.0);
        cam.zoom_at(1.5, 200.0, 300.0);
        let after = cam.screen_to_merc(200.0, 300.0);
        assert!(close(before.0, after.0, 1e-12) && close(before.1, after.1, 1e-12));
    }

    #[test]
    fn the_easing_runs_from_zero_to_one_and_never_back() {
        assert!(close(default_easing(0.0), 0.0, 1e-9));
        assert!(close(default_easing(1.0), 1.0, 1e-9));
        let mut last = 0.0;
        for i in 1..=20 {
            let v = default_easing(i as f64 / 20.0);
            assert!(v >= last);
            last = v;
        }
    }
}
