/**
 * The script injected into the recorded window.
 *
 * It draws a cursor, a click ring, and a caption inside the webview so the
 * recording shows intent without the app knowing anything about the preview. It
 * also keeps the console errors the checks report.
 */

export const OVERLAY_SCRIPT = String.raw`
(() => {
  if (window.__UI_PREVIEW__) {
    return;
  }

  const errors = [];
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map((value) => String(value)).join(' ').slice(0, 500));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(String(event.message || 'window error').slice(0, 500));
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(String(event.reason || 'unhandled rejection').slice(0, 500));
  });

  const layer = document.createElement('div');
  layer.id = '__ui_preview_overlay';
  layer.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:2147483647',
    'overflow:hidden',
  ].join(';');

  const cursor = document.createElement('div');
  cursor.style.cssText = [
    'position:absolute',
    'width:18px',
    'height:18px',
    'border-radius:50%',
    'background:rgba(255,255,255,0.92)',
    'border:2px solid rgba(20,20,20,0.75)',
    'box-shadow:0 2px 6px rgba(0,0,0,0.35)',
    'transform:translate(-50%,-50%)',
    'transition:left 220ms ease,top 220ms ease',
    'left:-100px',
    'top:-100px',
  ].join(';');

  // A short fading trail behind the cursor. A click is easier to follow when
  // the seconds before it are visible, not just the dot.
  const trail = document.createElement('canvas');
  trail.style.cssText = [
    'position:absolute',
    'inset:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
  ].join(';');
  const context = trail.getContext('2d');
  const points = [];
  const TRAIL_MS = 1400;
  let trailRunning = false;

  function sizeTrail() {
    const ratio = window.devicePixelRatio || 1;
    trail.width = Math.round(window.innerWidth * ratio);
    trail.height = Math.round(window.innerHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function drawTrail() {
    const now = performance.now();

    while (points.length > 0 && now - points[0].t > TRAIL_MS) {
      points.shift();
    }

    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1];
      const to = points[index];
      const age = (now - to.t) / TRAIL_MS;
      context.strokeStyle = 'rgba(37,99,235,' + (0.55 * (1 - age)).toFixed(3) + ')';
      context.lineWidth = 1 + 3 * (1 - age);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }

    if (points.length > 0) {
      requestAnimationFrame(drawTrail);
    } else {
      trailRunning = false;
    }
  }

  window.addEventListener('resize', sizeTrail);

  const caption = document.createElement('div');
  caption.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:14px',
    'transform:translateX(-50%)',
    'max-width:80%',
    'padding:6px 12px',
    'border-radius:999px',
    'background:rgba(17,17,17,0.86)',
    'color:#fff',
    'font:500 13px/1.4 system-ui,sans-serif',
    'opacity:0',
    'transition:opacity 160ms ease',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
  ].join(';');

  sizeTrail();
  layer.appendChild(trail);
  layer.appendChild(cursor);
  layer.appendChild(caption);
  document.documentElement.appendChild(layer);

  let captionTimer = null;

  window.__UI_PREVIEW__ = {
    moveTo(x, y) {
      points.push({ x, y, t: performance.now() });

      if (!trailRunning) {
        trailRunning = true;
        requestAnimationFrame(drawTrail);
      }

      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
    },
    ring(x, y) {
      const ring = document.createElement('div');
      ring.style.cssText = [
        'position:absolute',
        'left:' + x + 'px',
        'top:' + y + 'px',
        'width:14px',
        'height:14px',
        'border-radius:50%',
        'border:2px solid rgba(37,99,235,0.9)',
        'transform:translate(-50%,-50%)',
        'animation:__ui_preview_ring 520ms ease-out forwards',
      ].join(';');
      layer.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
    },
    caption(text) {
      if (!text) {
        return;
      }
      caption.textContent = text;
      caption.style.opacity = '1';
      clearTimeout(captionTimer);
      captionTimer = setTimeout(() => {
        caption.style.opacity = '0';
      }, 2200);
    },
    hide() {
      layer.style.display = 'none';
    },
    show() {
      layer.style.display = '';
    },
    errors() {
      return errors.slice(-20);
    },
  };

  const style = document.createElement('style');
  style.textContent =
    '@keyframes __ui_preview_ring{from{opacity:.9;transform:translate(-50%,-50%) scale(1)}to{opacity:0;transform:translate(-50%,-50%) scale(3.2)}}';
  document.documentElement.appendChild(style);
})();
`;

/**
 * Returns the center of an element in viewport coordinates, or null when the
 * element is gone. Used to place the overlay cursor before a real click.
 */
export const ELEMENT_CENTER_SCRIPT = String.raw`
const element = document.querySelector(arguments[0]);
if (!element) {
  return null;
}
const rect = element.getBoundingClientRect();
return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
`;

/**
 * The element's box and the viewport it sits in, both in CSS pixels, so a
 * screenshot taken in device pixels can be cropped to it.
 */
export const ELEMENT_RECT_SCRIPT = String.raw`
const element = document.querySelector(arguments[0]);
if (!element) {
  return null;
}
const rect = element.getBoundingClientRect();
if (rect.width < 1 || rect.height < 1) {
  return null;
}
return {
  rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  viewport: { width: window.innerWidth, height: window.innerHeight },
};
`;

/**
 * The element's row rather than the element alone.
 *
 * Cropping a switch on its own shows a toggle with no label, so the nearest
 * ancestor that spans most of the window and is still short enough to read is
 * used as the box.
 */
export const ELEMENT_ROW_RECT_SCRIPT = String.raw`
const element = document.querySelector(arguments[0]);
if (!element) {
  return null;
}
const own = element.getBoundingClientRect();
if (own.width < 1 || own.height < 1) {
  return null;
}
let rect = own;
for (let parent = element.parentElement; parent; parent = parent.parentElement) {
  const box = parent.getBoundingClientRect();
  if (box.width < window.innerWidth * 0.4 || box.height > window.innerHeight * 0.3) {
    break;
  }
  rect = box;
}
return {
  rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  viewport: { width: window.innerWidth, height: window.innerHeight },
};
`;
