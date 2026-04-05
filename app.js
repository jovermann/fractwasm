const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_VIEW = {
  centerX: -0.5,
  centerY: 0,
  scale: 3.5 / 960,
};

const palettes = {
  plasma: ['#0d0887', '#5c01a6', '#9c179e', '#cc4778', '#ed7953', '#fdb42f', '#f0f921'],
  inferno: ['#000004', '#320a5e', '#781c6d', '#bc3754', '#ed6925', '#fbb41a', '#fcffa4'],
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#bddf26', '#fde725'],
  cividis: ['#00224e', '#274d7e', '#4f6d8a', '#768b6d', '#a59c55', '#d2b746', '#fee838'],
  hotmetal: ['#120a0a', '#4f120e', '#8f2411', '#d14f11', '#ff9d19', '#ffe28c', '#fff7e2'],
  ocean: ['#09111c', '#103c5a', '#176b87', '#1ba3a3', '#8bd3c7', '#f0f7ff'],
  greys: ['#111111', '#2d2d2d', '#525252', '#737373', '#969696', '#bdbdbd', '#f0f0f0'],
};

const widthInput = document.getElementById('widthInput');
const heightInput = document.getElementById('heightInput');
const iterationsInput = document.getElementById('iterationsInput');
const paletteInput = document.getElementById('paletteInput');
const renderButton = document.getElementById('renderButton');
const resetViewButton = document.getElementById('resetViewButton');
const statusText = document.getElementById('statusText');
const loadingOverlay = document.getElementById('loadingOverlay');
const canvas = document.getElementById('fractalCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

let wasmInstance = null;
let wasmMemory = null;
let view = { ...DEFAULT_VIEW };
let dragState = null;
let pendingRender = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseHexColor(hex) {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function interpolatePalette(stops, t) {
  const span = stops.length - 1;
  const scaled = clamp(t, 0, 1) * span;
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(span, leftIndex + 1);
  const mix = scaled - leftIndex;
  const left = parseHexColor(stops[leftIndex]);
  const right = parseHexColor(stops[rightIndex]);
  return [
    Math.round(left[0] + (right[0] - left[0]) * mix),
    Math.round(left[1] + (right[1] - left[1]) * mix),
    Math.round(left[2] + (right[2] - left[2]) * mix),
  ];
}

function setStatus(message) {
  statusText.textContent = message;
}

function setLoading(isLoading) {
  loadingOverlay.hidden = !isLoading;
}

function syncDefaultScale() {
  const width = clamp(Number.parseInt(widthInput.value, 10) || 960, 160, 2048);
  DEFAULT_VIEW.scale = 3.5 / width;
}

function resetView() {
  syncDefaultScale();
  view = { ...DEFAULT_VIEW };
}

function validateDimensions() {
  const width = clamp(Number.parseInt(widthInput.value, 10) || 960, 160, 2048);
  const height = clamp(Number.parseInt(heightInput.value, 10) || 640, 120, 2048);
  const iterations = clamp(Number.parseInt(iterationsInput.value, 10) || 512, 32, 8192);
  widthInput.value = String(width);
  heightInput.value = String(height);
  iterationsInput.value = String(iterations);
  const requiredBytes = width * height * 4;
  if (requiredBytes > MEMORY_LIMIT_BYTES) {
    throw new Error(`Image size exceeds wasm memory budget (${Math.round(MEMORY_LIMIT_BYTES / (1024 * 1024))} MiB).`);
  }
  return { width, height, iterations };
}

async function loadWasm() {
  const response = await fetch('./mandelbrot.wasm', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load wasm module: HTTP ${response.status}`);
  }
  let instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(response, {}));
  } catch (_error) {
    const bytes = await response.arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, {}));
  }
  wasmInstance = instance;
  wasmMemory = instance.exports.memory;
}

function paintIterations(iterations, width, height, maxIterations) {
  const palette = palettes[paletteInput.value] || palettes.plasma;
  const image = ctx.createImageData(width, height);
  const pixels = image.data;
  for (let i = 0; i < iterations.length; i += 1) {
    const iter = iterations[i];
    const pixelIndex = i * 4;
    if (iter >= maxIterations) {
      pixels[pixelIndex] = 5;
      pixels[pixelIndex + 1] = 7;
      pixels[pixelIndex + 2] = 12;
      pixels[pixelIndex + 3] = 255;
      continue;
    }
    const normalized = Math.sqrt(iter / maxIterations);
    const [r, g, b] = interpolatePalette(palette, normalized);
    pixels[pixelIndex] = r;
    pixels[pixelIndex + 1] = g;
    pixels[pixelIndex + 2] = b;
    pixels[pixelIndex + 3] = 255;
  }
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(image, 0, 0);
}

function pointerToComplex(event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return {
    real: view.centerX + (x - canvas.width / 2) * view.scale,
    imag: view.centerY + (y - canvas.height / 2) * view.scale,
    px: x,
    py: y,
  };
}

async function render() {
  if (!wasmInstance || !wasmMemory) {
    return;
  }
  const token = ++pendingRender;
  const { width, height, iterations } = validateDimensions();
  setLoading(true);
  setStatus(`Rendering ${width}×${height} at ${iterations} iterations`);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const started = performance.now();
  const ptr = wasmInstance.exports.render(
    width,
    height,
    iterations,
    view.centerX,
    view.centerY,
    view.scale,
  );
  if (token !== pendingRender) {
    return;
  }
  const buffer = new Uint32Array(wasmMemory.buffer, ptr, width * height);
  paintIterations(buffer, width, height, iterations);
  const elapsed = performance.now() - started;
  const zoom = (3.5 / (view.scale * width)).toFixed(2);
  setLoading(false);
  setStatus(
    `Center ${view.centerX.toFixed(6)}, ${view.centerY.toFixed(6)} | Zoom ${zoom}× | ${elapsed.toFixed(1)} ms`,
  );
}

function scheduleRender() {
  window.clearTimeout(scheduleRender.timerId);
  scheduleRender.timerId = window.setTimeout(() => {
    render().catch((error) => {
      setLoading(false);
      setStatus(error.message);
    });
  }, 120);
}

async function initialize() {
  try {
    await loadWasm();
    resetView();
    await render();
  } catch (error) {
    setStatus(error.message);
    throw error;
  }
}

canvas.addEventListener('pointerdown', (event) => {
  if (canvas.width === 0 || canvas.height === 0) {
    return;
  }
  const start = pointerToComplex(event);
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startCenterX: view.centerX,
    startCenterY: view.centerY,
  };
  canvas.classList.add('dragging');
  canvas.setPointerCapture(event.pointerId);
  setStatus(`Pan from ${start.real.toFixed(6)}, ${start.imag.toFixed(6)}`);
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  view.centerX = dragState.startCenterX - dx * view.scale;
  view.centerY = dragState.startCenterY - dy * view.scale;
  scheduleRender();
});

canvas.addEventListener('pointerup', (event) => {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  dragState = null;
  canvas.classList.remove('dragging');
  canvas.releasePointerCapture(event.pointerId);
  scheduleRender();
});

canvas.addEventListener('pointercancel', () => {
  dragState = null;
  canvas.classList.remove('dragging');
});

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (canvas.width === 0 || canvas.height === 0) {
    return;
  }
  const point = pointerToComplex(event);
  const zoomFactor = event.deltaY < 0 ? 0.82 : 1.22;
  view.scale *= zoomFactor;
  view.centerX = point.real - (point.px - canvas.width / 2) * view.scale;
  view.centerY = point.imag - (point.py - canvas.height / 2) * view.scale;
  scheduleRender();
}, { passive: false });

canvas.addEventListener('dblclick', (event) => {
  const point = pointerToComplex(event);
  view.centerX = point.real;
  view.centerY = point.imag;
  view.scale *= 0.55;
  scheduleRender();
});

renderButton.addEventListener('click', () => {
  render().catch((error) => {
    setLoading(false);
    setStatus(error.message);
  });
});

resetViewButton.addEventListener('click', () => {
  resetView();
  render().catch((error) => {
    setLoading(false);
    setStatus(error.message);
  });
});

for (const input of [widthInput, heightInput, iterationsInput, paletteInput]) {
  input.addEventListener('change', () => {
    if (input === widthInput || input === heightInput) {
      syncDefaultScale();
    }
    scheduleRender();
  });
}

initialize().catch((error) => {
  console.error(error);
});
