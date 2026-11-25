function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed:\n${log}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  let fs: WebGLShader;
  try {
    fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  } catch (e) {
    gl.deleteShader(vs);
    throw e;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed:\n${log}`);
  }
  return program;
}

/** Looks up uniform locations by name; throws on typos instead of silently returning null. */
export function uniforms<const T extends readonly string[]>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: T,
): Record<T[number], WebGLUniformLocation> {
  const out = {} as Record<T[number], WebGLUniformLocation>;
  for (const name of names) {
    const location = gl.getUniformLocation(program, name);
    if (!location) throw new Error(`uniform ${name} not found (unused uniforms are optimized out)`);
    out[name as T[number]] = location;
  }
  return out;
}

/** The sheet's color under Dark Pages: what pageColor() makes of white. */
export const DARK_PAGE_RGB = 0x28292d;
/** What it makes of black. */
const DARK_TEXT_RGB = 0xe3e3e0;

/**
 * Dark Pages: a document color as it shows on a dark page. The lightness flips and the hue stays,
 * so white paper turns dark grey, black letters light grey, and red stays red. Declares the
 * `u_darkPages` uniform (0 or 1); pasted into a shader before its main().
 */
export const DARK_PAGES_GLSL = /* glsl */ `
uniform float u_darkPages;
uniform float u_forced;
uniform vec3 u_forcedPage;
uniform vec3 u_forcedText;
vec3 pageColor(vec3 c) {
  // The system's high contrast colors (forced-colors): light colors become the page's, every other one the text's.
  if (u_forced > 0.5) return dot(c, vec3(0.2126, 0.7152, 0.0722)) > 0.6 ? u_forcedPage : u_forcedText;
  vec3 flipped = c + (1.0 - max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b));
  return mix(c, mix(vec3(${hexToGlsl(DARK_PAGE_RGB)}), vec3(${hexToGlsl(DARK_TEXT_RGB)}), flipped), u_darkPages);
}
`;

/** The same for what is drawn over the canvas in CSS: a color (0xRRGGBB) as Dark Pages shows it. */
export function darkPageColor(rgb: number): number {
  const c = [rgb >> 16, rgb >> 8, rgb].map((v) => (v & 255) / 255);
  const shift = 1 - Math.max(...c) - Math.min(...c);
  const at = (i: number) => {
    const from = (DARK_PAGE_RGB >> (16 - 8 * i)) & 255;
    const to = (DARK_TEXT_RGB >> (16 - 8 * i)) & 255;
    return Math.round(from + (to - from) * (c[i] + shift));
  };
  return (at(0) << 16) | (at(1) << 8) | at(2);
}

/** The system's high contrast colors (Windows' contrast themes: the forced-colors media feature), 0xRRGGBB, or null when it has none. */
export interface ForcedColors {
  page: number;
  text: number;
}

/** Sets the `u_forced*` uniforms DARK_PAGES_GLSL declares (they are found by name, so a program need not list them). */
export function setForcedUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, forced: ForcedColors | null): void {
  const rgb = (v: number): [number, number, number] => [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  // Looked up once per program: this runs on every draw.
  let at = forcedLocations.get(program);
  if (!at) {
    at = { on: gl.getUniformLocation(program, 'u_forced'), page: gl.getUniformLocation(program, 'u_forcedPage'), text: gl.getUniformLocation(program, 'u_forcedText') };
    forcedLocations.set(program, at);
  }
  gl.uniform1f(at.on, forced ? 1 : 0);
  if (!forced) return;
  gl.uniform3f(at.page, ...rgb(forced.page));
  gl.uniform3f(at.text, ...rgb(forced.text));
}
const forcedLocations = new WeakMap<WebGLProgram, { on: WebGLUniformLocation | null; page: WebGLUniformLocation | null; text: WebGLUniformLocation | null }>();

function hexToGlsl(rgb: number): string {
  return [rgb >> 16, (rgb >> 8) & 255, rgb & 255].map((v) => (v / 255).toFixed(4)).join(', ');
}
