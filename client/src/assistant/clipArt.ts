// Clip: a black binder clip with a face, tilted a little to the left. A black wedge, wide at the bottom (its
// front is the face), with rolled tabs along its narrow top edge, where the wire handles are hinged, the tall chrome bail rising from them
// and the second handle leaning over behind it (the same loop, hinged at the same tabs, nearly as tall, leaning a little right and shifted left so it comes out from behind). Motion is CSS (assistant.css): the eyes blink, the
// pupils follow the pointer (index.ts sets --look-x/y on each eye), and the whole clip fidgets while it thinks.

const FRONT = 'M20 52H78L90 100H8Z';
const BAIL = 'M20 52C30 44 40 36 41 28C42 20 36 17 36 11C36 4 44 3 52 3C60 3 67 5 67 12C67 18 61 21 60 28C59 36 68 44 78 52';

export const CLIP_SVG = `<svg class="wm-clip-art" viewBox="0 0 104 114" width="85" height="93" aria-hidden="true" focusable="false">
  <g transform="rotate(-7 49 76)">
    <g class="wm-clip-shape" stroke-linecap="round" stroke-linejoin="round">
      <path class="halo" d="${FRONT}"/>
      <g transform="translate(-9 0) translate(49 52) skewX(-15) scale(1 0.94) translate(-49 -52)">
        <path class="bail-outline" d="${BAIL}" fill="none"/>
        <path class="bail" d="${BAIL}" fill="none"/>
      </g>
      <path class="bail-outline" d="${BAIL}" fill="none"/>
      <path class="bail" d="${BAIL}" fill="none"/>
      <path class="bail-shine" d="M38 14C39 8 44 5 51 5" fill="none"/>
      <path class="body" d="${FRONT}"/>
      <path class="edge" d="M22 57L11 96" fill="none"/>
      <path class="rim" d="M22 55H76" fill="none"/>
      <rect class="tab" x="6" y="45" width="34" height="10" rx="4.5"/>
      <rect class="tab" x="58" y="45" width="27" height="10" rx="4.5"/>
      <path class="tab-shine" d="M11 48H36M62 48H81" fill="none"/>
    </g>
    <g class="wm-clip-face">
      <path class="brow left" d="M29 64q8-7 17-1"/>
      <path class="brow right" d="M52 63q9-6 17 1"/>
      <g transform="translate(39 77)"><g class="eye"><ellipse class="white" rx="8.5" ry="10.5"/><circle class="pupil" r="4.2"/></g></g>
      <g transform="translate(59 77)"><g class="eye"><ellipse class="white" rx="8.5" ry="10.5"/><circle class="pupil" r="4.2"/></g></g>
      <path class="mouth" d="M43 92q6 4.5 12 0"/>
    </g>
  </g>
</svg>`;
