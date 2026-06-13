// Builds the source images @capacitor/assets needs, from the SideBet brand mark.
// Run: node assets/generate-sources.js  (then: npx capacitor-assets generate)
const sharp = require('sharp');
const path = require('path');

const OUT = __dirname;
const MINT_A = '#5cf0b0', MINT_B = '#22d3a8';
const BG_A = '#101820', BG_B = '#0b0f14';

// The brand mark on a transparent canvas, sized to `px`. A diagonal "side bet"
// line connecting two stake chips.
function markSVG(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="m" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${MINT_A}"/><stop offset="1" stop-color="${MINT_B}"/>
      </linearGradient>
      <filter id="g" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="22" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <g filter="url(#g)">
      <path d="M360 664 L664 360" stroke="url(#m)" stroke-width="64" stroke-linecap="round"/>
      <circle cx="360" cy="664" r="96" fill="url(#m)"/>
      <circle cx="664" cy="360" r="96" fill="url(#m)"/>
      <circle cx="360" cy="664" r="40" fill="${BG_B}"/>
      <circle cx="664" cy="360" r="40" fill="${BG_B}"/>
    </g>
  </svg>`;
}

function bgSVG(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}">
    <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BG_A}"/><stop offset="1" stop-color="${BG_B}"/>
    </linearGradient></defs>
    <rect width="${px}" height="${px}" fill="url(#b)"/>
  </svg>`;
}

async function png(svg) { return sharp(Buffer.from(svg)).png().toBuffer(); }

// Compose a centered mark of width `markPx` onto a `size` background buffer.
async function compose(size, bgBuf, markPx, file) {
  const mark = await png(markSVG(markPx));
  await sharp(bgBuf).composite([{ input: mark, gravity: 'center' }]).png().toFile(path.join(OUT, file));
  console.log('wrote', file);
}

(async () => {
  const dark1024 = await png(bgSVG(1024));
  const dark2732 = await png(bgSVG(2732));
  const clear1024 = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

  // Full app icon (iOS + Android legacy): mark large on dark square.
  await compose(1024, dark1024, 760, 'icon.png');
  // Android adaptive: foreground (mark in safe zone) + solid background.
  await compose(1024, clear1024, 620, 'icon-foreground.png');
  await sharp(dark1024).toFile(path.join(OUT, 'icon-background.png')); console.log('wrote icon-background.png');
  // Splash screens.
  await compose(2732, dark2732, 760, 'splash.png');
  await compose(2732, dark2732, 760, 'splash-dark.png');
})();
