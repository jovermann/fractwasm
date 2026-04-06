const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_VIEW = {
  centerX: -0.5,
  centerY: 0,
  scale: 3.5 / 1024,
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
const cycleLengthInput = document.getElementById('cycleLengthInput');
const cyclePhaseInput = document.getElementById('cyclePhaseInput');
const algoInput = document.getElementById('algoInput');
const modeInput = document.getElementById('modeInput');
const progressInput = document.getElementById('progressInput');
const debugInput = document.getElementById('debugInput');
const renderButton = document.getElementById('renderButton');
const resetViewButton = document.getElementById('resetViewButton');
const statusText = document.getElementById('statusText');
const loadingOverlay = document.getElementById('loadingOverlay');
const canvas = document.getElementById('fractalCanvas');
const juliaCanvas = document.getElementById('juliaCanvas');
const juliaPane = document.getElementById('juliaPane');
const viewerStage = document.getElementById('viewerStage');
const ctx = canvas.getContext('2d', { alpha: false });
const juliaCtx = juliaCanvas.getContext('2d', { alpha: false });

let wasmInstance = null;
let wasmMemory = null;
let view = { ...DEFAULT_VIEW };
let dragState = null;
let pendingRender = 0;
let lastFrame = null;
let dirtyRenderGeneration = 0;
let dirtyRenderRunning = false;
let dirtyRenderQueue = [];
let dirtyRenderNeedsRestart = false;
let juliaRenderToken = 0;
let juliaScheduleTimer = null;
let mouseJuliaPoint = null;
let sceneVersion = 0;
let wasmWorkQueue = Promise.resolve();

const sizeOptions = [];
for (let size = 128; size <= 2048; size *= 2) {
  sizeOptions.push(size);
  const intermediate = Math.floor(size * 1.5);
  if (intermediate < 2048) {
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

function readCycleSettings() {
  const rawValue = String(cycleLengthInput.value || '256');
  const alternating = rawValue.endsWith('-alt');
  const lengthText = alternating ? rawValue.slice(0, -4) : rawValue;
  const length = Math.max(1, Number.parseInt(lengthText, 10) || 256);
  return { length, alternating, rawValue };
}

function readMode() {
  return String(modeInput.value || 'mandelbrot');
}

function readAlgo() {
  return String(algoInput.value || 'plain');
}

async function withWasmLock(work) {
  const previous = wasmWorkQueue;
  let release;
  wasmWorkQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

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
  const size = clamp(Number.parseInt(sizeInput.value, 10) || 512, 128, 2048);
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
  const size = clamp(Number.parseInt(sizeInput.value, 10) || 512, 128, 2048);
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
  const image = ctx.createImageData(width, height);
  paintRegionIntoImage(image, iterations, 0, 0, width, height, maxIterations);
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(image, 0, 0);
  return image;
}

function paintRegionIntoImage(image, iterations, startX, startY, regionWidth, regionHeight, maxIterations) {
  const palette = palettes[paletteInput.value] || palettes.spectrum;
  const cycle = readCycleSettings();
  const cyclePhase = Number.parseFloat(cyclePhaseInput.value) || 0;
  const pixels = image.data;
  for (let y = 0; y < regionHeight; y += 1) {
    for (let x = 0; x < regionWidth; x += 1) {
      const i = y * regionWidth + x;
      const pixelIndex = ((startY + y) * image.width + startX + x) * 4;
      const iter = iterations[i];
      if (iter >= maxIterations) {
        pixels[pixelIndex] = 5;
        pixels[pixelIndex + 1] = 7;
        pixels[pixelIndex + 2] = 12;
        pixels[pixelIndex + 3] = 255;
        continue;
      }
      let normalized = (((iter % cycle.length) / cycle.length) + cyclePhase) % 1;
      if (cycle.alternating && (iter % 2 === 1)) {
        normalized = (normalized + 0.5) % 1;
      }
      const [r, g, b] = interpolatePalette(palette, normalized);
      pixels[pixelIndex] = r;
      pixels[pixelIndex + 1] = g;
      pixels[pixelIndex + 2] = b;
      pixels[pixelIndex + 3] = 255;
    }
  }
}

function fillBlue(image) {
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 18;
    pixels[i + 1] = 64;
    pixels[i + 2] = 160;
    pixels[i + 3] = 255;
  }
}

function cloneImageData(source) {
  const clone = ctx.createImageData(source.width, source.height);
  clone.data.set(source.data);
  return clone;
}

function cancelDirtyQueue() {
  dirtyRenderGeneration += 1;
  dirtyRenderQueue = [];
  dirtyRenderNeedsRestart = false;
}

function fillBlueRegion(image, startX, startY, regionWidth, regionHeight) {
  const pixels = image.data;
  for (let y = 0; y < regionHeight; y += 1) {
    for (let x = 0; x < regionWidth; x += 1) {
      const pixelIndex = ((startY + y) * image.width + startX + x) * 4;
      pixels[pixelIndex] = 18;
      pixels[pixelIndex + 1] = 64;
      pixels[pixelIndex + 2] = 160;
      pixels[pixelIndex + 3] = 255;
    }
  }
}

function isBluePixel(pixels, pixelIndex) {
  return (
    pixels[pixelIndex] === 18
    && pixels[pixelIndex + 1] === 64
    && pixels[pixelIndex + 2] === 160
    && pixels[pixelIndex + 3] === 255
  );
}

function extractDirtyRegionsFromImage(image) {
  const regions = [];
  const pixels = image.data;
  let activeRuns = [];
  for (let y = 0; y < image.height; y += 1) {
    const rowRuns = [];
    let x = 0;
    while (x < image.width) {
      const pixelIndex = (y * image.width + x) * 4;
      if (!isBluePixel(pixels, pixelIndex)) {
        x += 1;
        continue;
      }
      const startX = x;
      x += 1;
      while (x < image.width && isBluePixel(pixels, (y * image.width + x) * 4)) {
        x += 1;
      }
      rowRuns.push({ x: startX, width: x - startX });
    }

    const nextActiveRuns = [];
    for (const run of rowRuns) {
      const existing = activeRuns.find((entry) => entry.x === run.x && entry.width === run.width);
      if (existing) {
        existing.height += 1;
        existing.touched = true;
        nextActiveRuns.push(existing);
      } else {
        nextActiveRuns.push({ x: run.x, y, width: run.width, height: 1, touched: true });
      }
    }

    for (const entry of activeRuns) {
      if (!entry.touched) {
        regions.push({ x: entry.x, y: entry.y, width: entry.width, height: entry.height });
      }
    }

    activeRuns = nextActiveRuns.map((entry) => ({
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      touched: false,
    }));
  }

  for (const entry of activeRuns) {
    regions.push({ x: entry.x, y: entry.y, width: entry.width, height: entry.height });
  }
  return regions;
}

function renderRegion(width, height, iterations, centerX, centerY, scale, startX, startY, regionWidth, regionHeight) {
  wasmInstance.exports.render(
    width,
    height,
    iterations,
    centerX,
    centerY,
    scale,
    startX,
    startY,
    regionWidth,
    regionHeight,
  );
  return new Uint32Array(wasmMemory.buffer, 0, regionWidth * regionHeight);
}

function getFullImageBuffer(width, height) {
  return new Uint32Array(wasmMemory.buffer, 0, width * height);
}

function makeSsgDisplayBuffer(width, height, cellSize) {
  const source = getFullImageBuffer(width, height);
  const display = new Uint32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sampleY = Math.min(height - 1, Math.floor(y / cellSize) * cellSize);
    for (let x = 0; x < width; x += 1) {
      const sampleX = Math.min(width - 1, Math.floor(x / cellSize) * cellSize);
      display[(y * width) + x] = source[(sampleY * width) + sampleX];
    }
  }
  return display;
}

function getSsgMaskOffset(width, height) {
  return width * height * 4;
}

function getSsgMaskBuffer(width, height) {
  return new Uint8Array(wasmMemory.buffer, getSsgMaskOffset(width, height), width * height);
}

function paintSsgDebugMask(image) {
  if (!debugInput.checked || readAlgo() !== 'ssg') {
    return;
  }
  const mask = getSsgMaskBuffer(image.width, image.height);
  const pixels = image.data;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) {
      continue;
    }
    const pixelIndex = i * 4;
    pixels[pixelIndex] = 255;
    pixels[pixelIndex + 1] = 255;
    pixels[pixelIndex + 2] = 255;
    pixels[pixelIndex + 3] = 255;
  }
}

function updateModeLayout() {
  const dual = readMode() !== 'mandelbrot';
  juliaPane.hidden = !dual;
  viewerStage.classList.toggle('dual', dual);
}

function invalidateScene() {
  sceneVersion += 1;
  juliaRenderToken += 1;
  window.clearTimeout(juliaScheduleTimer);
}

function getJuliaParameter() {
  const mode = readMode();
  if (mode === 'mand-center-julia') {
    return { real: view.centerX, imag: view.centerY };
  }
  if (mode === 'mand-mouse-julia') {
    return mouseJuliaPoint || { real: view.centerX, imag: view.centerY };
  }
  return null;
}

function renderJuliaFull(width, height, iterations, cReal, cImag) {
  wasmInstance.exports.render_julia(
    width,
    height,
    iterations,
    0,
    0,
    3.2 / width,
    cReal,
    cImag,
    0,
    0,
    width,
    height,
  );
  const image = juliaCtx.createImageData(width, height);
  paintRegionIntoImage(image, getFullImageBuffer(width, height), 0, 0, width, height, iterations);
  juliaCanvas.width = width;
  juliaCanvas.height = height;
  juliaCtx.putImageData(image, 0, 0);
}

async function renderJulia() {
  if (!wasmInstance || !juliaCtx) {
    return;
  }
  const mode = readMode();
  if (mode === 'mandelbrot') {
    return;
  }
  const { width, height, iterations } = validateDimensions();
  const juliaParam = getJuliaParameter();
  if (!juliaParam) {
    return;
  }
  const token = ++juliaRenderToken;
  const version = sceneVersion;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (token !== juliaRenderToken || version !== sceneVersion) {
    return;
  }
  await withWasmLock(async () => {
    if (token !== juliaRenderToken || version !== sceneVersion) {
      return;
    }
    renderJuliaFull(width, height, iterations, juliaParam.real, juliaParam.imag);
  });
}

function scheduleJuliaRender(delay = 80) {
  window.clearTimeout(juliaScheduleTimer);
  juliaScheduleTimer = window.setTimeout(() => {
    renderJulia().catch((error) => {
      setStatus(error.message);
    });
  }, delay);
}

async function renderRegionPlainIntoImage(task) {
  const {
    width,
    height,
    iterations,
    centerX,
    centerY,
    scale,
    region,
    image,
    progress,
    shouldAbort,
  } = task;
  const batchRows = progress ? Math.max(1, Math.ceil(region.height / 16)) : region.height;
  let localRowsDone = 0;
  let paintedPixels = 0;
  while (localRowsDone < region.height) {
    if (shouldAbort()) {
      return { aborted: true, paintedPixels };
    }
    const rowCount = Math.min(batchRows, region.height - localRowsDone);
    const regionBuffer = renderRegion(
      width,
      height,
      iterations,
      centerX,
      centerY,
      scale,
      region.x,
      region.y + localRowsDone,
      region.width,
      rowCount,
    );
    paintRegionIntoImage(image, regionBuffer, region.x, region.y + localRowsDone, region.width, rowCount, iterations);
    localRowsDone += rowCount;
    paintedPixels += region.width * rowCount;
    if (progress) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { aborted: false, paintedPixels };
}

async function renderRegionIntoImage(task) {
  return renderRegionPlainIntoImage(task);
}

async function renderFullImageSsg(width, height, iterations, centerX, centerY, scale, image, progress, shouldAbort) {
  getSsgMaskBuffer(width, height).fill(0);
  const maskOffset = getSsgMaskOffset(width, height);
  wasmInstance.exports.render_ssg_grid(width, height, iterations, centerX, centerY, scale, 16);
  if (shouldAbort()) {
    return { aborted: true };
  }
  if (progress) {
    paintRegionIntoImage(image, makeSsgDisplayBuffer(width, height, 16), 0, 0, width, height, iterations);
    paintSsgDebugMask(image);
    ctx.putImageData(image, 0, 0);
    setStatus('SSG grid 16');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  for (const halfStep of [8, 4, 2, 1]) {
    if (shouldAbort()) {
      return { aborted: true };
    }
    wasmInstance.exports.refine_ssg(width, height, iterations, centerX, centerY, scale, halfStep, maskOffset);
    if (progress) {
      paintRegionIntoImage(image, makeSsgDisplayBuffer(width, height, halfStep), 0, 0, width, height, iterations);
      paintSsgDebugMask(image);
      ctx.putImageData(image, 0, 0);
      setStatus(`SSG refine ${halfStep}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  paintRegionIntoImage(image, getFullImageBuffer(width, height), 0, 0, width, height, iterations);
  paintSsgDebugMask(image);
  return { aborted: false };
}

function shiftImageData(source, shiftX, shiftY) {
  const shifted = ctx.createImageData(source.width, source.height);
  const src = source.data;
  const dest = shifted.data;
  for (let y = 0; y < source.height; y += 1) {
    const destY = y + shiftY;
    if (destY < 0 || destY >= source.height) continue;
    for (let x = 0; x < source.width; x += 1) {
      const destX = x + shiftX;
      if (destX < 0 || destX >= source.width) continue;
      const srcIndex = (y * source.width + x) * 4;
      const destIndex = (destY * source.width + destX) * 4;
      dest[destIndex] = src[srcIndex];
      dest[destIndex + 1] = src[srcIndex + 1];
      dest[destIndex + 2] = src[srcIndex + 2];
      dest[destIndex + 3] = src[srcIndex + 3];
    }
  }
  return shifted;
}

function buildExposedRegions(width, height, shiftX, shiftY) {
  const regions = [];
  const leftStrip = shiftX > 0 ? shiftX : 0;
  const rightStrip = shiftX < 0 ? -shiftX : 0;
  if (shiftX > 0) {
    regions.push({ x: 0, y: 0, width: shiftX, height });
  } else if (shiftX < 0) {
    regions.push({ x: width + shiftX, y: 0, width: -shiftX, height });
  }
  if (shiftY > 0) {
    regions.push({ x: leftStrip, y: 0, width: width - leftStrip - rightStrip, height: shiftY });
  } else if (shiftY < 0) {
    regions.push({ x: leftStrip, y: height + shiftY, width: width - leftStrip - rightStrip, height: -shiftY });
  }
  return regions.filter((region) => region.width > 0 && region.height > 0);
}

function translateDirtyRegions(regions, width, height, shiftX, shiftY) {
  if (!Array.isArray(regions) || regions.length === 0) {
    return [];
  }
  const translated = [];
  for (const region of regions) {
    const x0 = Math.max(0, region.x + shiftX);
    const y0 = Math.max(0, region.y + shiftY);
    const x1 = Math.min(width, region.x + shiftX + region.width);
    const y1 = Math.min(height, region.y + shiftY + region.height);
    const clippedWidth = x1 - x0;
    const clippedHeight = y1 - y0;
    if (clippedWidth > 0 && clippedHeight > 0) {
      translated.push({ x: x0, y: y0, width: clippedWidth, height: clippedHeight });
    }
  }
  return translated;
}

function previewPanFrame(baseFrame, shiftX, shiftY) {
  if (Math.abs(shiftX) >= baseFrame.width || Math.abs(shiftY) >= baseFrame.height) {
    return null;
  }

  const image = shiftImageData(baseFrame.imageData, shiftX, shiftY);
  const shiftedDirtyRegions = translateDirtyRegions(
    baseFrame.dirtyRegions,
    baseFrame.width,
    baseFrame.height,
    shiftX,
    shiftY,
  );
  const exposedRegions = buildExposedRegions(baseFrame.width, baseFrame.height, shiftX, shiftY);
  const regions = shiftedDirtyRegions.concat(exposedRegions);
  for (const region of regions) {
    fillBlueRegion(image, region.x, region.y, region.width, region.height);
  }
  canvas.width = baseFrame.width;
  canvas.height = baseFrame.height;
  ctx.putImageData(image, 0, 0);
  return { image, regions };
}

function canRenderDirtyRegions(width, height, iterations) {
  if (!lastFrame || !lastFrame.dirty) return false;
  return (
    lastFrame.width === width
    && lastFrame.height === height
    && lastFrame.iterations === iterations
    && lastFrame.palette === paletteInput.value
    && lastFrame.cycleMode === readCycleSettings().rawValue
    && lastFrame.cyclePhase === (Number.parseFloat(cyclePhaseInput.value) || 0)
    && lastFrame.algo === readAlgo()
    && lastFrame.scale === view.scale
    && lastFrame.centerX === view.centerX
    && lastFrame.centerY === view.centerY
    && Array.isArray(lastFrame.dirtyRegions)
    && lastFrame.dirtyRegions.length > 0
  );
}

function queueDirtyRegions(frame) {
  cancelDirtyQueue();
  frame.dirtyRegions = extractDirtyRegionsFromImage(frame.imageData);
  if (frame.dirtyRegions.length === 0) {
    frame.dirty = false;
    frame.completedDirtyPixels = 0;
    frame.totalDirtyPixels = 0;
    return;
  }
  const generation = dirtyRenderGeneration;
  frame.completedDirtyPixels = 0;
  frame.totalDirtyPixels = frame.dirtyRegions.reduce((sum, region) => sum + region.width * region.height, 0);
  dirtyRenderQueue = frame.dirtyRegions.map((region) => ({
    generation,
    frame,
    region,
  }));
  dirtyRenderNeedsRestart = true;
  kickDirtyQueue();
}

function restartDirtyRegionsFromCurrentFrame() {
  if (!lastFrame || !lastFrame.dirty || !Array.isArray(lastFrame.dirtyRegions) || lastFrame.dirtyRegions.length === 0) {
    return;
  }
  queueDirtyRegions(lastFrame);
}

function kickDirtyQueue() {
  if (dirtyRenderRunning) {
    return;
  }
  if (dirtyRenderQueue.length === 0) {
    return;
  }
  dirtyRenderNeedsRestart = false;
  processDirtyQueue(dirtyRenderGeneration);
}

async function processDirtyQueue(generation) {
  if (dirtyRenderRunning) {
    return;
  }
  dirtyRenderRunning = true;
  try {
    while (dirtyRenderQueue.length > 0) {
      const task = dirtyRenderQueue.shift();
      if (!task) {
        continue;
      }
      if (task.generation !== dirtyRenderGeneration || task.generation !== generation) {
        continue;
      }
      if (lastFrame !== task.frame || !task.frame.dirty) {
        continue;
      }
      const showProgress = progressInput.checked;
      let lastPaint = performance.now();
      const result = await withWasmLock(() => renderRegionIntoImage({
        width: task.frame.width,
        height: task.frame.height,
        iterations: task.frame.iterations,
        centerX: task.frame.centerX,
        centerY: task.frame.centerY,
        scale: task.frame.scale,
        region: task.region,
        image: task.frame.imageData,
        progress: showProgress,
        shouldAbort: () => task.generation !== dirtyRenderGeneration || lastFrame !== task.frame || !task.frame.dirty,
      }));
      if (result.aborted) {
        return;
      }
      task.frame.completedDirtyPixels += result.paintedPixels;
      const now = performance.now();
      if (showProgress && (now - lastPaint >= 200 || task.frame.completedDirtyPixels === task.frame.totalDirtyPixels)) {
        if (lastFrame === task.frame) {
          ctx.putImageData(task.frame.imageData, 0, 0);
          const percent = task.frame.totalDirtyPixels > 0
            ? Math.round((task.frame.completedDirtyPixels / task.frame.totalDirtyPixels) * 100)
            : 100;
          setStatus(`Rendering exposed regions | ${percent}%`);
        }
        lastPaint = now;
      }
      if (!showProgress && lastFrame === task.frame) {
        ctx.putImageData(task.frame.imageData, 0, 0);
      }
    }
    if (generation === dirtyRenderGeneration && lastFrame && lastFrame.dirty && dirtyRenderQueue.length === 0) {
      lastFrame.dirty = false;
      lastFrame.dirtyRegions = [];
      const zoom = (3.5 / (lastFrame.scale * lastFrame.width)).toFixed(2);
      setStatus(
        `Center ${lastFrame.centerX.toFixed(6)}, ${lastFrame.centerY.toFixed(6)} | Zoom ${zoom}×`,
      );
    }
  } finally {
    dirtyRenderRunning = false;
    if (dirtyRenderNeedsRestart || dirtyRenderQueue.length > 0) {
      window.setTimeout(() => {
        kickDirtyQueue();
      }, 0);
    }
  }
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
  invalidateScene();
  cancelDirtyQueue();
  const cycle = readCycleSettings();
  const algo = readAlgo();
  const token = ++pendingRender;
  const { width, height, iterations } = validateDimensions();
  setLoading(true);
  setStatus(`Rendering ${width}×${height} at ${iterations} iterations`);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const started = performance.now();
  await withWasmLock(async () => {
    if (canRenderDirtyRegions(width, height, iterations)) {
      const showProgress = progressInput.checked;
      const image = ctx.createImageData(width, height);
      image.data.set(lastFrame.imageData.data);
      const regions = lastFrame.dirtyRegions.slice();
      let completedArea = 0;
      const totalArea = regions.reduce((sum, region) => sum + region.width * region.height, 0);
      let lastPaint = performance.now();
      canvas.width = width;
      canvas.height = height;
      ctx.putImageData(image, 0, 0);

      for (const region of regions) {
        const result = await renderRegionIntoImage({
          width,
          height,
          iterations,
          centerX: view.centerX,
          centerY: view.centerY,
          scale: view.scale,
          region,
          image,
          progress: showProgress,
          shouldAbort: () => token !== pendingRender,
        });
        if (result.aborted) {
          return;
        }
        completedArea += result.paintedPixels;
        const now = performance.now();
        if (showProgress && (now - lastPaint >= 200 || completedArea === totalArea)) {
          ctx.putImageData(image, 0, 0);
          const percent = totalArea > 0 ? Math.round((completedArea / totalArea) * 100) : 100;
          setStatus(`Rendering exposed regions | ${percent}%`);
          lastPaint = now;
        }
      }
      if (!showProgress) {
        ctx.putImageData(image, 0, 0);
      }
      lastFrame = {
        width,
        height,
        iterations,
        palette: paletteInput.value,
        cycleMode: cycle.rawValue,
        cyclePhase: Number.parseFloat(cyclePhaseInput.value) || 0,
        algo,
        centerX: view.centerX,
        centerY: view.centerY,
        scale: view.scale,
        imageData: image,
        dirty: false,
        dirtyRegions: [],
      };
    } else {
      const showProgress = progressInput.checked;
      const image = ctx.createImageData(width, height);
      fillBlue(image);
      canvas.width = width;
      canvas.height = height;
      if (showProgress) {
        ctx.putImageData(image, 0, 0);
      }
      const result = algo === 'ssg'
        ? await renderFullImageSsg(
          width,
          height,
          iterations,
          view.centerX,
          view.centerY,
          view.scale,
          image,
          showProgress,
          () => token !== pendingRender,
        )
        : await renderRegionIntoImage({
          width,
          height,
          iterations,
          centerX: view.centerX,
          centerY: view.centerY,
          scale: view.scale,
          region: { x: 0, y: 0, width, height },
          image,
          progress: showProgress,
          shouldAbort: () => token !== pendingRender,
        });
      if (result.aborted) {
        return;
      }
      if (showProgress) {
        ctx.putImageData(image, 0, 0);
        setStatus(`Rendering ${width}×${height} at ${iterations} iterations | 100%`);
      } else {
        ctx.putImageData(image, 0, 0);
      }

      lastFrame = {
        width,
        height,
        iterations,
        palette: paletteInput.value,
        cycleMode: cycle.rawValue,
        cyclePhase: Number.parseFloat(cyclePhaseInput.value) || 0,
        algo,
        centerX: view.centerX,
        centerY: view.centerY,
        scale: view.scale,
        imageData: image,
        dirty: false,
        dirtyRegions: [],
      };
    }
  });
  const elapsed = performance.now() - started;
  const zoom = (3.5 / (view.scale * width)).toFixed(2);
  setLoading(false);
  setStatus(
    `Center ${view.centerX.toFixed(6)}, ${view.centerY.toFixed(6)} | Zoom ${zoom}× | ${elapsed.toFixed(1)} ms`,
  );
  scheduleJuliaRender(0);
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
    updateModeLayout();
    populateSelect(sizeInput, sizeOptions, 1024);
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
    rectWidth: canvas.getBoundingClientRect().width || canvas.width,
    rectHeight: canvas.getBoundingClientRect().height || canvas.height,
    lastShiftX: 0,
    lastShiftY: 0,
  };
  cancelDirtyQueue();
  canvas.classList.add('dragging');
  canvas.setPointerCapture(event.pointerId);
  setStatus(`Pan from ${start.real.toFixed(6)}, ${start.imag.toFixed(6)}`);
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  const cycle = readCycleSettings();
  const dxClient = event.clientX - dragState.startX;
  const dyClient = event.clientY - dragState.startY;
  const dxPixels = dxClient * (canvas.width / dragState.rectWidth);
  const dyPixels = dyClient * (canvas.height / dragState.rectHeight);
  view.centerX = dragState.startCenterX - dxPixels * view.scale;
  view.centerY = dragState.startCenterY - dyPixels * view.scale;
  const absoluteShiftX = Math.round(dxPixels);
  const absoluteShiftY = Math.round(dyPixels);
  const shiftX = absoluteShiftX - dragState.lastShiftX;
  const shiftY = absoluteShiftY - dragState.lastShiftY;
  if (shiftX === 0 && shiftY === 0) {
    return;
  }
  const frame = lastFrame;
  if (!frame) return;
  const preview = previewPanFrame(frame, shiftX, shiftY);
  if (!preview) {
    setStatus('Pan preview unavailable for this move. Press Render to recompute.');
    lastFrame = null;
    return;
  }
  dragState.lastShiftX = absoluteShiftX;
  dragState.lastShiftY = absoluteShiftY;
  lastFrame = {
    width: frame.width,
    height: frame.height,
    iterations: frame.iterations,
    palette: frame.palette,
    cycleMode: cycle.rawValue,
    cyclePhase: Number.parseFloat(cyclePhaseInput.value) || 0,
    algo: readAlgo(),
    centerX: view.centerX,
    centerY: view.centerY,
    scale: frame.scale,
    imageData: preview.image,
    dirty: true,
    dirtyRegions: preview.regions,
    completedDirtyPixels: 0,
    totalDirtyPixels: 0,
  };
  const dirtyPixels = preview.regions.reduce((sum, region) => sum + region.width * region.height, 0);
  const percent = Math.round((dirtyPixels / (frame.width * frame.height)) * 100);
  setStatus(`Pan preview | ${percent}% dirty | rendering queue started`);
  queueDirtyRegions(lastFrame);
  if (readMode() === 'mand-center-julia') {
    scheduleJuliaRender();
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  dragState = null;
  canvas.classList.remove('dragging');
  canvas.releasePointerCapture(event.pointerId);
  if (lastFrame && lastFrame.dirty) {
    restartDirtyRegionsFromCurrentFrame();
    setStatus('Pan preview ready | queued region rendering continues');
    kickDirtyQueue();
  }
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
  invalidateScene();
  lastFrame = null;
  scheduleRender();
}, { passive: false });

canvas.addEventListener('dblclick', (event) => {
  const point = pointerToComplex(event);
  view.centerX = point.real;
  view.centerY = point.imag;
  view.scale *= 0.55;
  invalidateScene();
  lastFrame = null;
  scheduleRender();
});

canvas.addEventListener('pointermove', (event) => {
  if (readMode() !== 'mand-mouse-julia') {
    return;
  }
  mouseJuliaPoint = pointerToComplex(event);
  scheduleJuliaRender();
});

canvas.addEventListener('pointerleave', () => {
  if (readMode() !== 'mand-mouse-julia') {
    return;
  }
  mouseJuliaPoint = null;
  scheduleJuliaRender();
});

renderButton.addEventListener('click', () => {
  render().catch((error) => {
    setLoading(false);
    setStatus(error.message);
  });
});

resetViewButton.addEventListener('click', () => {
  resetView();
  invalidateScene();
  cancelDirtyQueue();
  lastFrame = null;
  render().catch((error) => {
    setLoading(false);
    setStatus(error.message);
  });
});

for (const input of [sizeInput, iterationsInput, paletteInput, algoInput]) {
  input.addEventListener('change', () => {
    if (input === sizeInput) {
      const previousSize = Number.parseInt(sizeInput.dataset.previousValue || sizeInput.value, 10);
      const nextSize = Number.parseInt(sizeInput.value, 10);
      syncViewScaleForSizeChange(previousSize, nextSize);
      sizeInput.dataset.previousValue = String(nextSize);
      syncDefaultScale();
    }
    if (input !== paletteInput) {
      invalidateScene();
      cancelDirtyQueue();
      lastFrame = null;
    }
    scheduleRender();
  });
}

for (const input of [cycleLengthInput, cyclePhaseInput]) {
  input.addEventListener('change', () => {
    invalidateScene();
    cancelDirtyQueue();
    lastFrame = null;
    scheduleRender();
  });
}

modeInput.addEventListener('change', () => {
  invalidateScene();
  updateModeLayout();
  scheduleJuliaRender(0);
});

progressInput.addEventListener('change', () => {
  scheduleRender();
});

debugInput.addEventListener('change', () => {
  scheduleRender();
});

initialize().catch((error) => {
  console.error(error);
});
