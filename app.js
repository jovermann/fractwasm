const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_VIEW = {
  centerX: -0.5,
  centerY: 0,
  scale: 3.5 / 512,
};

const palettes = {
  spectrum: ['#ff5e5b', '#ffbe0b', '#f7ff58', '#4dd599', '#00bbf9', '#4361ee', '#8338ec', '#ff006e', '#ff5e5b'],
  'fire-ice': ['#ff7b00', '#ffb700', '#ffe566', '#e8f7ff', '#8ecae6', '#219ebc', '#023047', '#6a00f4', '#ff7b00'],
  'viridian-loop': ['#123524', '#1f6f50', '#2ea97d', '#8fd694', '#d9ed92', '#8fd694', '#2ea97d', '#1f6f50', '#123524'],
  'ember-loop': ['#2b0b0b', '#7f1d1d', '#c2410c', '#fb923c', '#fde68a', '#fb923c', '#c2410c', '#7f1d1d', '#2b0b0b'],
  nocturne: ['#03045e', '#023e8a', '#0077b6', '#0096c7', '#48cae4', '#90e0ef', '#560bad', '#7209b7', '#03045e'],
  'mono-loop': ['#111111', '#3a3a3a', '#737373', '#bdbdbd', '#f3f3f3', '#bdbdbd', '#737373', '#3a3a3a', '#111111'],
};

const sizeInput = document.getElementById('sizeInput');
const iterationsInput = document.getElementById('iterationsInput');
const paletteInput = document.getElementById('paletteInput');
const alternatingInput = document.getElementById('alternatingInput');
const progressInput = document.getElementById('progressInput');
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

const sizeOptions = [];
for (let size = 128; size <= 4096; size *= 2) {
  sizeOptions.push(size);
  const intermediate = Math.floor(size * 1.5);
  if (intermediate < 4096) {
    sizeOptions.push(intermediate);
  }
}

const iterationOptions = [];
for (const base of [1, 2, 5]) {
  let value = base * 10;
  while (value <= 1000000) {
    iterationOptions.push(value);
    value *= 10;
  }
}
iterationOptions.sort((a, b) => a - b);

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

function populateSelect(select, values, selectedValue) {
  select.textContent = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    if (value === selectedValue) {
      option.selected = true;
    }
    select.append(option);
  }
}

function syncDefaultScale() {
  const size = clamp(Number.parseInt(sizeInput.value, 10) || 512, 128, 4096);
  DEFAULT_VIEW.scale = 3.5 / size;
}

function syncViewScaleForSizeChange(previousSize, nextSize) {
  if (!Number.isFinite(previousSize) || !Number.isFinite(nextSize) || previousSize <= 0 || nextSize <= 0) {
    return;
  }
  view.scale *= previousSize / nextSize;
}

function resetView() {
  syncDefaultScale();
  view = { ...DEFAULT_VIEW };
}

function validateDimensions() {
  const size = clamp(Number.parseInt(sizeInput.value, 10) || 512, 128, 4096);
  const iterations = clamp(Number.parseInt(iterationsInput.value, 10) || 500, 10, 1000000);
  sizeInput.value = String(size);
  iterationsInput.value = String(iterations);
  const requiredBytes = size * size * 4;
  if (requiredBytes > MEMORY_LIMIT_BYTES) {
    throw new Error(`Image size exceeds wasm memory budget (${Math.round(MEMORY_LIMIT_BYTES / (1024 * 1024))} MiB).`);
  }
  return { width: size, height: size, iterations };
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
  paintIterationsPartial(iterations, width, height, maxIterations, height);
}

function paintIterationsPartial(iterations, width, height, maxIterations, completedRows) {
  const palette = palettes[paletteInput.value] || palettes.spectrum;
  const image = ctx.createImageData(width, height);
  const pixels = image.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const pixelIndex = i * 4;
      if (y >= completedRows) {
        pixels[pixelIndex] = 18;
        pixels[pixelIndex + 1] = 64;
        pixels[pixelIndex + 2] = 160;
        pixels[pixelIndex + 3] = 255;
        continue;
      }
      const iter = iterations[i];
      if (iter >= maxIterations) {
        pixels[pixelIndex] = 5;
        pixels[pixelIndex + 1] = 7;
        pixels[pixelIndex + 2] = 12;
        pixels[pixelIndex + 3] = 255;
        continue;
      }
      let normalized = Math.sqrt(iter / maxIterations);
      if (alternatingInput.checked && (iter % 2 === 1)) {
        normalized = (normalized + 0.5) % 1;
      }
      normalized = normalized % 1;
      const [r, g, b] = interpolatePalette(palette, normalized);
      pixels[pixelIndex] = r;
      pixels[pixelIndex + 1] = g;
      pixels[pixelIndex + 2] = b;
      pixels[pixelIndex + 3] = 255;
    }
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
  const ptr = 0;
  const buffer = new Uint32Array(wasmMemory.buffer, ptr, width * height);
  const showProgress = progressInput.checked;
  const batchRows = showProgress ? Math.max(1, Math.ceil(height / 16)) : height;
  let completedRows = 0;
  let lastPaint = performance.now();

  if (showProgress) {
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = '#1240a0';
    ctx.fillRect(0, 0, width, height);
  }

  while (completedRows < height) {
    const rowCount = Math.min(batchRows, height - completedRows);
    wasmInstance.exports.render(
      width,
      height,
      iterations,
      view.centerX,
      view.centerY,
      view.scale,
      completedRows,
      rowCount,
    );
    completedRows += rowCount;
    if (token !== pendingRender) {
      return;
    }
    const now = performance.now();
    if (showProgress && (now - lastPaint >= 200 || completedRows === height)) {
      paintIterationsPartial(buffer, width, height, iterations, completedRows);
      const percent = Math.round((completedRows / height) * 100);
      setStatus(`Rendering ${width}×${height} at ${iterations} iterations | ${percent}%`);
      lastPaint = now;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

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
    populateSelect(sizeInput, sizeOptions, 512);
    populateSelect(iterationsInput, iterationOptions, 500);
    sizeInput.dataset.previousValue = sizeInput.value;
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

for (const input of [sizeInput, iterationsInput, paletteInput]) {
  input.addEventListener('change', () => {
    if (input === sizeInput) {
      const previousSize = Number.parseInt(sizeInput.dataset.previousValue || sizeInput.value, 10);
      const nextSize = Number.parseInt(sizeInput.value, 10);
      syncViewScaleForSizeChange(previousSize, nextSize);
      sizeInput.dataset.previousValue = String(nextSize);
      syncDefaultScale();
    }
    scheduleRender();
  });
}

alternatingInput.addEventListener('change', () => {
  scheduleRender();
});

progressInput.addEventListener('change', () => {
  scheduleRender();
});

initialize().catch((error) => {
  console.error(error);
});
