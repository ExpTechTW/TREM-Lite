// The basemap and everything drawn on it. No MSAA: lines work out their own edge
// from the distance across them, as MapLibre's do, and fills lie under the outlines.
// Everything blends premultiplied in gamma space, as CSS and MapLibre do.

struct Globals {
    viewport: vec2f,
    dpr: f32,
    zoom: f32,
};

struct Draw {
    origin: vec2f,   // Screen position of the geometry's (0, 0), physical pixels.
    scale: f32,      // Physical pixels per geometry unit.
    extent: f32,     // Tile coordinates outside 0..extent are not drawn; 0 means no clip.
    color: vec4f,    // Premultiplied.
    width: f32,      // Line width or circle radius, logical pixels.
    opacity: f32,
    use_lookup: f32,
    icon_size: f32,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var lookup: texture_2d<f32>;
@group(0) @binding(2) var sprite: texture_2d<f32>;
@group(0) @binding(3) var linear: sampler;
@group(1) @binding(0) var<uniform> d: Draw;
@group(2) @binding(0) var shade: texture_2d<f32>;

fn to_clip(px: vec2f) -> vec4f {
    return vec4f(px.x / g.viewport.x * 2.0 - 1.0, 1.0 - px.y / g.viewport.y * 2.0, 0.0, 1.0);
}

// ---- Fills ------------------------------------------------------------------

struct FillOut {
    @builtin(position) pos: vec4f,
    @location(0) tile: vec2f,
    @location(1) @interpolate(flat) code: u32,
};

@vertex
fn vs_fill_tile(@location(0) p: vec2<i32>, @location(1) code: vec2<u32>) -> FillOut {
    var out: FillOut;
    let tile = vec2f(p);
    out.pos = to_clip(d.origin + tile * d.scale);
    out.tile = tile;
    out.code = code.x;
    return out;
}

@vertex
fn vs_fill_overlay(@location(0) p: vec2f) -> FillOut {
    var out: FillOut;
    out.pos = to_clip(d.origin + p * d.scale);
    out.tile = vec2f(0.0);
    out.code = 0u;
    return out;
}

fn inside_tile(tile: vec2f) -> bool {
    if (d.extent <= 0.0) {
        return true;
    }
    return tile.x >= 0.0 && tile.y >= 0.0 && tile.x <= d.extent && tile.y <= d.extent;
}

@fragment
fn fs_fill(in: FillOut) -> @location(0) vec4f {
    if (!inside_tile(in.tile)) {
        discard;
    }
    var color = d.color;
    if (d.use_lookup > 0.5 && in.code < 1024u) {
        let painted = textureLoad(lookup, vec2<i32>(i32(in.code % 32u), i32(in.code / 32u)), 0);
        if (painted.a > 0.0) {
            color = painted;
        }
    }
    return color * d.opacity;
}

// ---- Lines ------------------------------------------------------------------

struct LineOut {
    @builtin(position) pos: vec4f,
    @location(0) tile: vec2f,
    @location(1) across: f32,
    @location(2) outset: f32,
    @location(3) color: vec4f,
};

fn line_out(position: vec2f, n: vec4<i32>, tile: vec2f, color: vec4f) -> LineOut {
    var out: LineOut;
    // MapLibre's line shader: half the width plus half a pixel, fading over a pixel.
    let half_width = d.width * g.dpr * 0.5;
    let outset = half_width + 0.5;
    let normal = vec2f(f32(n.x), f32(n.y)) / 64.0;
    out.pos = to_clip(position + normal * outset);
    out.tile = tile;
    out.across = f32(n.z) * outset;
    out.outset = outset;
    out.color = color;
    return out;
}

@vertex
fn vs_line_tile(@location(0) p: vec2<i32>, @location(1) n: vec4<i32>) -> LineOut {
    let tile = vec2f(p);
    return line_out(d.origin + tile * d.scale, n, tile, d.color);
}

@vertex
fn vs_line_overlay(
    @location(0) p: vec2f,
    @location(1) n: vec4<i32>,
    @location(2) color: vec4f,
) -> LineOut {
    return line_out(d.origin + p * d.scale, n, vec2f(0.0), vec4f(color.rgb * color.a, color.a));
}

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4f {
    if (!inside_tile(in.tile)) {
        discard;
    }
    let alpha = clamp(in.outset - abs(in.across), 0.0, 1.0);
    return in.color * d.opacity * alpha;
}

// ---- Hillshade --------------------------------------------------------------

struct ShadeOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_shade(@builtin(vertex_index) i: u32) -> ShadeOut {
    var corners = array<vec2f, 6>(
        vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
        vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    );
    let uv = corners[i];
    var out: ShadeOut;
    out.pos = to_clip(d.origin + uv * d.scale);
    out.uv = uv;
    return out;
}

@fragment
fn fs_shade(in: ShadeOut) -> @location(0) vec4f {
    let t = textureSample(shade, linear, in.uv);
    return vec4f(t.r, t.r, t.r, t.g);
}

// ---- Circles ----------------------------------------------------------------

struct CircleOut {
    @builtin(position) pos: vec4f,
    @location(0) extrude: vec2f,
    @location(1) color: vec4f,
    @location(2) blur: f32,
};

@vertex
fn vs_circle(
    @builtin(vertex_index) i: u32,
    @location(0) p: vec2f,
    @location(1) color: vec4f,
) -> CircleOut {
    var corners = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
        vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    );
    let extrude = corners[i];
    let radius = d.width * g.dpr;
    var out: CircleOut;
    out.pos = to_clip(d.origin + p * d.scale + extrude * radius);
    out.extrude = extrude;
    out.color = vec4f(color.rgb * color.a, color.a);
    out.blur = 1.0 / max(radius, 0.001);
    return out;
}

@fragment
fn fs_circle(in: CircleOut) -> @location(0) vec4f {
    // MapLibre's: fade over one pixel inward from the radius.
    let alpha = 1.0 - smoothstep(-in.blur, 0.0, length(in.extrude) - 1.0);
    return in.color * d.opacity * alpha;
}

// ---- Icons ------------------------------------------------------------------

struct IconOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) opacity: f32,
};

@vertex
fn vs_icon(
    @builtin(vertex_index) i: u32,
    @location(0) p: vec2f,
    @location(1) size_opacity: vec2f,
    @location(2) rect: vec4f,
) -> IconOut {
    var corners = array<vec2f, 6>(
        vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
        vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    );
    let c = corners[i];
    let size = size_opacity.x * d.icon_size * g.dpr;
    var out: IconOut;
    out.pos = to_clip(d.origin + p * d.scale + (c - vec2f(0.5)) * size);
    out.uv = rect.xy + c * rect.zw;
    out.opacity = size_opacity.y;
    return out;
}

@fragment
fn fs_icon(in: IconOut) -> @location(0) vec4f {
    return textureSample(sprite, linear, in.uv) * in.opacity * d.opacity;
}
