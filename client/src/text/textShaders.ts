// Instanced MSDF text. One instance per glyph; the quad's 4 corners come from gl_VertexID,
// and the glyph's quad and atlas UVs are fetched from the face's glyph table texture.

export const TEXT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_position; // pen position on the baseline (document units, batch-relative)
layout(location = 1) in float a_size;    // document units per em
layout(location = 2) in uint a_glyph;
layout(location = 3) in vec4 a_color;

uniform highp sampler2D u_glyphTable; // row per glyph: texel 0 = plane bounds (em), texel 1 = atlas UVs
uniform vec2 u_translate;             // batch origin on screen, device px
uniform float u_scale;                // device px per document unit
uniform vec2 u_viewport;              // device px
uniform float u_distanceRangeEm;      // SDF range in ems
uniform float u_skew;                 // synthetic italic shear

out vec2 v_uv;
flat out float v_screenPxRange;
flat out vec4 v_color;

void main() {
  // Triangle strip corners: (0,0) (1,0) (0,1) (1,1)
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  int row = int(a_glyph);
  vec4 plane = texelFetch(u_glyphTable, ivec2(0, row), 0);
  vec4 atlas = texelFetch(u_glyphTable, ivec2(1, row), 0);

  vec2 local = mix(plane.xy, plane.zw, corner);
  local.x -= local.y * u_skew;
  vec2 screen = (a_position + local * a_size) * u_scale + u_translate;
  gl_Position = vec4(screen / u_viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);

  v_uv = mix(atlas.xy, atlas.zw, corner);
  // How many screen pixels the SDF range spans at this size; drives edge antialiasing.
  v_screenPxRange = max(u_distanceRangeEm * a_size * u_scale, 1.0);
  v_color = a_color;
}
`;

export const TEXT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;

uniform mediump sampler2D u_atlas;
uniform vec2 u_atlasSize; // texels
uniform float u_embolden; // synthetic bold, in SDF units (0 = none)

in highp vec2 v_uv;
flat in float v_screenPxRange;
flat in vec4 v_color;

out vec4 outColor;

float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}

float coverage(highp vec2 uv, float pxRange) {
  // Explicit LOD: sampled inside a branch, and the atlas has no mipmaps anyway.
  vec3 msdf = textureLod(u_atlas, uv, 0.0).rgb;
  float distance = median(msdf.r, msdf.g, msdf.b) - 0.5 + u_embolden;
  return clamp(distance * pxRange + 0.5, 0.0, 1.0);
}

void main() {
  highp vec2 dx = dFdx(v_uv);
  highp vec2 dy = dFdy(v_uv);
  // Atlas texels spanned by one screen pixel. Above ~1.5 the single bilinear sample aliases
  // (zoomed-out text shimmers), so average a 2x2 rotated grid instead. Mipmaps aren't an
  // option: tightly packed glyphs bleed into each other at smaller levels.
  float footprint = max(length(dx * u_atlasSize), length(dy * u_atlasSize));
  float c;
  if (footprint > 1.5) {
    c = 0.25 * (
      coverage(v_uv - 0.125 * dx - 0.375 * dy, v_screenPxRange) +
      coverage(v_uv + 0.375 * dx - 0.125 * dy, v_screenPxRange) +
      coverage(v_uv + 0.125 * dx + 0.375 * dy, v_screenPxRange) +
      coverage(v_uv - 0.375 * dx + 0.125 * dy, v_screenPxRange));
  } else {
    c = coverage(v_uv, v_screenPxRange);
  }
  float alpha = v_color.a * c;
  outColor = vec4(v_color.rgb * alpha, alpha); // premultiplied
}
`;
