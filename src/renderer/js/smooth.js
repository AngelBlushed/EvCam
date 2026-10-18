'use strict';

/**
 * Frame smoothing ("post-processing"): when the phone delivers fewer pictures per second than the virtual camera
 * outputs (a camera limited to 20 fps, a phone that cannot keep up...), the missing pictures are computed instead of
 * repeating the last one.
 *
 * Between two received frames A and B, a picture at time t (0..1) is built by moving pixels of A forward and pixels of
 * B backward along the motion between them, then mixing the two. The motion comes from block matching (mvworker.js).
 * Where the motion estimate is not reliable (something appears or hides, a movement too fast to follow) the nearest
 * real frame is used, so the worst case is the usual judder and never a smeared double image.
 *
 * Cost: one picture of delay (the next frame must be known) and a bit of GPU / CPU. It cannot remove the motion blur
 * a camera records at a long exposure; it only makes the motion regular.
 */

const EST_W = 256;
const EST_H = 144;
const BLOCKS_X = 32;
const BLOCKS_Y = 18;

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);   // one triangle that covers the screen
  vUv = vec2(p.x, 1.0 - p.y);                                // image space: y goes down
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uCurr;
uniform sampler2D uMv;
uniform float uT;
uniform vec2 uMvScale;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 v = texture(uMv, vUv).rg * uMvScale;                   // movement prev -> curr, in picture units
  vec4 a = texture(uPrev, vUv - v * uT);
  vec4 b = texture(uCurr, vUv + v * (1.0 - uT));
  // how well do the two moved pictures agree? a wrong vector (something appears or hides, a movement too fast to
  // follow) shows up as a disagreement: there the nearest real frame is used, so the worst case is the usual
  // judder and never a smeared picture
  vec3 d = abs(a.rgb - b.rgb);
  float err = max(d.r, max(d.g, d.b));
  vec4 mixed = mix(a, b, uT);
  vec4 nearest = uT < 0.5 ? texture(uPrev, vUv) : texture(uCurr, vUv);
  o = vec4(mix(mixed, nearest, smoothstep(0.07, 0.2, err)).rgb, 1.0);
}`;

class FrameSmoother {
  /** @param {string} workerUrl where mvworker.js is, relative to the page */
  constructor(workerUrl = 'js/mvworker.js') {
    this.ok = false;
    this.error = '';
    this.canvas = document.createElement('canvas');
    this.width = 0;
    this.height = 0;
    this.n = 0;                 // frames received since the last reset
    this.seq = 0;
    this.mvSeq = -1;            // sequence number the current vector field belongs to
    this.pending = null;
    try {
      const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL 2 indisponible');
      this.gl = gl;
      this._init(gl);
      this.est = document.createElement('canvas');
      this.est.width = EST_W;
      this.est.height = EST_H;
      this.estCtx = this.est.getContext('2d', { willReadFrequently: true });
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = (e) => this._onVectors(e.data);
      this.ok = true;
    } catch (err) {
      this.error = err.message || String(err);
    }
  }

  _compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  _init(gl) {
    const prog = gl.createProgram();
    gl.attachShader(prog, this._compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, this._compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);
    this.u = {
      prev: gl.getUniformLocation(prog, 'uPrev'),
      curr: gl.getUniformLocation(prog, 'uCurr'),
      mv: gl.getUniformLocation(prog, 'uMv'),
      t: gl.getUniformLocation(prog, 'uT'),
      scale: gl.getUniformLocation(prog, 'uMvScale')
    };
    gl.uniform1i(this.u.prev, 0);
    gl.uniform1i(this.u.curr, 1);
    gl.uniform1i(this.u.mv, 2);
    gl.uniform2f(this.u.scale, 1 / EST_W, 1 / EST_H);
    this.vao = gl.createVertexArray();
    const mk = (filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex = [mk(gl.LINEAR), mk(gl.LINEAR)];
    this.cur = 0;               // index of the texture holding the newest frame
    this.mvTex = mk(gl.LINEAR);
    this._setVectors(new Float32Array(BLOCKS_X * BLOCKS_Y * 2));
  }

  _setVectors(data) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.mvTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, BLOCKS_X, BLOCKS_Y, 0, gl.RG, gl.FLOAT, data);
  }

  _onVectors({ seq, mv }) {
    if (!this.ok || seq < this.mvSeq) return;
    this.mvSeq = seq;
    this.lastMv = mv; // (kept for diagnostics)
    this._setVectors(mv || new Float32Array(BLOCKS_X * BLOCKS_Y * 2));
    this.pending = null;
  }

  reset() {
    this.n = 0;
    this.mvSeq = -1;
  }

  /** A new frame arrived from the phone (the VideoFrame is only read here, the caller keeps owning it). */
  push(frame) {
    if (!this.ok) return;
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (!w || !h) return;
    const gl = this.gl;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      gl.viewport(0, 0, w, h);
      this.reset();
    }
    const next = 1 - this.cur;
    gl.activeTexture(gl.TEXTURE0 + next);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[next]);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    } catch (err) {
      this.ok = false;
      this.error = `Texture : ${err.message}`;
      return;
    }
    // after this swap: tex[cur] = newest, tex[1 - cur] = previous. The shader reads prev from unit 0 and curr from unit 1
    this.cur = next;
    this.n++;
    this.seq++;
    // a small copy goes to the worker for the motion estimation
    this.estCtx.drawImage(frame, 0, 0, EST_W, EST_H);
    const img = this.estCtx.getImageData(0, 0, EST_W, EST_H);
    this.worker.postMessage({ seq: this.seq, rgba: img.data.buffer }, [img.data.buffer]);
  }

  get ready() { return this.ok && this.n >= 2; }

  /** The picture at fraction t (0 = previous frame, 1 = newest) of the interval between the last two frames. */
  render(t) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1 - this.cur]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.mvTex);
    gl.useProgram(this.prog);
    gl.uniform1f(this.u.t, Math.min(1, Math.max(0, t)));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  dispose() {
    this.ok = false;
    try { this.worker.terminate(); } catch { /* ignore */ }
    try { const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch { /* ignore */ }
  }
}

module.exports = { FrameSmoother };
