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
