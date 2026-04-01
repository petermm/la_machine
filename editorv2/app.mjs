import {
  buildJsonLine,
  defaultSequence,
  extractEditorInput,
  parseChoreography,
  serializeChoreography
} from "./parser.mjs";
import {
  createBlocklyWorkspace,
  syncServoBlockEstimates,
  sequenceToWorkspace,
  workspaceToSequence
} from "./blockly_editor.mjs";
import {
  computeTimeline,
  renderMachineView,
  renderTimeline,
  timelineTimeFromClientX
} from "./visualizer.mjs";

function byId(root, id) {
  return root.querySelector(`#${id}`);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function loadChoreographyCatalog() {
  try {
    const response = await fetch("../choreographies.json");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function renderDiagnostics(listElement, countElement, diagnostics) {
  listElement.innerHTML = "";
  countElement.textContent = String(diagnostics.length);

  if (!diagnostics.length) {
    const item = document.createElement("li");
    item.dataset.level = "info";
    item.textContent = "No parser or timeline issues detected.";
    listElement.appendChild(item);
    return;
  }

  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    item.dataset.level = diagnostic.level;
    item.textContent = diagnostic.message;
    listElement.appendChild(item);
  }
}

function describeStatus({
  hasBlockly,
  diagnostics,
  unresolvedAudioCount,
  selectedName
}) {
  if (!hasBlockly) {
    return "Blockly is unavailable, so the page is running in text-preview mode only.";
  }

  if (diagnostics.some((item) => item.level === "error")) {
    return "The choreography parsed with errors. Fix the diagnostics before trusting the output.";
  }

  if (unresolvedAudioCount > 0) {
    return `Loaded ${selectedName || "current"}; resolving ${unresolvedAudioCount} audio duration(s) for the preview.`;
  }

  return `Editing ${selectedName || "current"} with Blockly and a Processing-style timeline preview.`;
}

function formatSeconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function buildSoundUrl(baseInput, path) {
  return new URL(path, new URL(baseInput, window.location.href)).toString();
}

const DEFAULT_START_SCENARIO = "excited_00784";

function getAudioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function ensureAudioContext(state) {
  if (state.audioContext) {
    return state.audioContext;
  }

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    return null;
  }

  state.audioContext = new AudioContextConstructor();
  return state.audioContext;
}

async function ensureRunningAudioContext(state) {
  const audioContext = ensureAudioContext(state);
  if (!audioContext) {
    return null;
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext;
}

function stopScheduledAudio(state) {
  for (const source of state.playback.scheduledAudioSources.values()) {
    source.onended = null;
    try {
      source.stop(0);
    } catch (_error) {
    }
    try {
      source.disconnect();
    } catch (_error) {
    }
  }
  state.playback.scheduledAudioSources.clear();
}

function destroyPreloadedAudio(state) {
  stopScheduledAudio(state);
  state.preloadedAudio.clear();
}

function resizeBlocklyWorkspace(state) {
  if (!state.workspace || !window.Blockly?.svgResize) {
    return;
  }
  window.requestAnimationFrame(() => {
    window.Blockly.svgResize(state.workspace);
  });
}

function buildWaveformPeaks(buffer, bucketCount = 160) {
  const channelCount = Math.max(1, buffer.numberOfChannels || 1);
  const sampleCount = Math.max(1, buffer.length || 1);
  const buckets = Math.max(16, Math.min(bucketCount, sampleCount));
  const peaks = new Array(buckets).fill(0);
  const samplesPerBucket = Math.max(1, Math.floor(sampleCount / buckets));
  const channelData = Array.from(
    { length: channelCount },
    (_unused, channelIndex) => buffer.getChannelData(channelIndex)
  );

  for (let bucketIndex = 0; bucketIndex < buckets; bucketIndex += 1) {
    const start = bucketIndex * samplesPerBucket;
    const end = bucketIndex === buckets - 1 ? sampleCount : Math.min(sampleCount, start + samplesPerBucket);
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      let mixedSample = 0;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        mixedSample += channelData[channelIndex][sampleIndex] || 0;
      }
      peak = Math.max(peak, Math.abs(mixedSample / channelCount));
    }

    peaks[bucketIndex] = peak;
  }

  const maxPeak = peaks.reduce((max, value) => Math.max(max, value), 0);
  if (maxPeak <= 0) {
    return peaks;
  }

  return peaks.map((value) => value / maxPeak);
}

async function loadPreloadedAudioEntry(state, entry, refresh) {
  const audioContext = ensureAudioContext(state);
  if (!audioContext) {
    entry.error = true;
    refresh();
    return;
  }

  try {
    const response = await fetch(entry.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    if (state.preloadedAudio.get(entry.id) !== entry) {
      return;
    }

    entry.buffer = buffer;
    entry.waveformPeaks = buildWaveformPeaks(buffer);
    entry.ready = true;
    entry.error = false;

    if (Number.isFinite(buffer.duration) && buffer.duration > 0) {
      state.soundDurations.set(entry.path, Math.round(buffer.duration * 1000));
    }

    refresh();
  } catch (_error) {
    if (state.preloadedAudio.get(entry.id) !== entry) {
      return;
    }

    entry.ready = false;
    entry.error = true;
    refresh();
  }
}

function createAudioPreloader(state, refresh) {
  return function ensurePreloadedAudio(audioEvents) {
    const baseInput = state.elements.soundsBaseUrl.value.trim();
    for (const [eventId, entry] of state.preloadedAudio.entries()) {
      const stillNeeded = audioEvents.some((event) => event.id === eventId);
      if (!stillNeeded || !baseInput) {
        state.preloadedAudio.delete(eventId);
      }
    }

    if (!baseInput) {
      return;
    }

    for (const event of audioEvents) {
      const url = buildSoundUrl(baseInput, event.path);
      const existing = state.preloadedAudio.get(event.id);
      if (existing && existing.url === url) {
        continue;
      }

      if (existing) {
        destroyAudioElement(existing.audio);
        state.preloadedAudio.delete(event.id);
      }

      const entry = {
        id: event.id,
        path: event.path,
        url,
        buffer: null,
        waveformPeaks: null,
        ready: false,
        error: false
      };
      state.preloadedAudio.set(event.id, entry);
      void loadPreloadedAudioEntry(state, entry, refresh);
    }
  };
}

function getPlaybackElapsedMs(state, nowMs = performance.now()) {
  if (!state.playback.isPlaying || !state.currentTimeline) {
    return state.playback.elapsedMs;
  }

  if (state.audioContext && Number.isFinite(state.playback.startedAtAudioTimeSec)) {
    return Math.min(
      (state.audioContext.currentTime - state.playback.startedAtAudioTimeSec) * 1000,
      state.currentTimeline.durationMs
    );
  }

  return Math.min(nowMs - state.playback.startedAtMs, state.currentTimeline.durationMs);
}

function schedulePreviewAudio(state, elapsedMs) {
  stopScheduledAudio(state);

  if (!state.currentTimeline || !state.audioContext) {
    return;
  }

  for (const event of state.currentTimeline.audioEvents) {
    const entry = state.preloadedAudio.get(event.id);
    if (!entry?.buffer || entry.error) {
      continue;
    }

    const offsetSeconds = Math.max(0, (elapsedMs - event.anchorMs) / 1000);
    if (offsetSeconds >= entry.buffer.duration) {
      continue;
    }

    const delaySeconds = Math.max(0, (event.anchorMs - elapsedMs) / 1000);
    const source = state.audioContext.createBufferSource();
    source.buffer = entry.buffer;
    source.connect(state.audioContext.destination);
    source.onended = () => {
      if (state.playback.scheduledAudioSources.get(event.id) === source) {
        state.playback.scheduledAudioSources.delete(event.id);
      }
    };
    source.start(state.audioContext.currentTime + delaySeconds, offsetSeconds);
    state.playback.scheduledAudioSources.set(event.id, source);
  }
}

function buildWaveformMap(state) {
  const waveformByAudioEventId = new Map();
  for (const [eventId, entry] of state.preloadedAudio.entries()) {
    if (Array.isArray(entry.waveformPeaks) && entry.waveformPeaks.length > 0) {
      waveformByAudioEventId.set(eventId, entry.waveformPeaks);
    }
  }
  return waveformByAudioEventId;
}

function dispatchChange(root, detail) {
  root.dispatchEvent(
    new CustomEvent("editorv2:change", {
      detail,
      bubbles: true
    })
  );
}

export function mountEditorApp(root) {
  const elements = {
    scenarioPrev: byId(root, "scenario-prev"),
    scenarioNext: byId(root, "scenario-next"),
    scenarioName: byId(root, "scenario-name"),
    soundsBaseUrl: byId(root, "sounds-base-url"),
    scenarioSelect: byId(root, "scenario-select"),
    sourceText: byId(root, "source-text"),
    parseText: byId(root, "parse-text"),
    loadSample: byId(root, "load-sample"),
    copySequence: byId(root, "copy-sequence"),
    copyJsonLine: byId(root, "copy-json-line"),
    blocklyHost: byId(root, "blockly-host"),
    blocklyFallback: byId(root, "blockly-fallback"),
    machineCanvas: byId(root, "machine-canvas"),
    timelineCanvas: byId(root, "timeline-canvas"),
    previewPlayToggle: byId(root, "preview-play-toggle"),
    previewPauseToggle: byId(root, "preview-pause-toggle"),
    previewTimeLabel: byId(root, "preview-time-label"),
    durationLabel: byId(root, "duration-label"),
    stepCountLabel: byId(root, "step-count-label"),
    audioCountLabel: byId(root, "audio-count-label"),
    servoCountLabel: byId(root, "servo-count-label"),
    sequenceOutput: byId(root, "sequence-output"),
    jsonLineOutput: byId(root, "json-line-output"),
    diagnosticsList: byId(root, "diagnostics-list"),
    diagnosticsCount: byId(root, "diagnostics-count"),
    statusLine: byId(root, "status-line")
  };

  const state = {
    elements,
    soundDurations: new Map(),
    preloadedAudio: new Map(),
    audioContext: null,
    catalog: null,
    catalogNames: [],
    workspace: null,
    hasBlockly: Boolean(window.Blockly),
    lastKnownSequence: defaultSequence(),
    parserDiagnostics: [],
    isApplyingWorkspaceImport: false,
    userTouchedSource: false,
    currentTimeline: null,
    playback: {
      isPlaying: false,
      isPaused: false,
      isScrubbing: false,
      scrubPointerId: null,
      elapsedMs: 0,
      startedAtMs: 0,
      startedAtAudioTimeSec: NaN,
      rafId: 0,
      scheduledAudioSources: new Map(),
      activeAudioEventIds: new Set()
    }
  };
  const emptyTimeline = computeTimeline([]);

  if (!state.hasBlockly) {
    elements.blocklyHost.classList.add("hidden");
    elements.blocklyFallback.classList.remove("hidden");
  } else {
    const { workspace } = createBlocklyWorkspace(elements.blocklyHost);
    state.workspace = workspace;
  }

  function stopPreviewPlayback(reason = "", resetElapsed = true) {
    if (state.playback.rafId) {
      window.cancelAnimationFrame(state.playback.rafId);
      state.playback.rafId = 0;
    }

    stopScheduledAudio(state);
    state.playback.activeAudioEventIds.clear();
    state.playback.isPlaying = false;
    state.playback.isPaused = false;
    state.playback.isScrubbing = false;
    state.playback.scrubPointerId = null;
    state.playback.startedAtAudioTimeSec = NaN;
    if (resetElapsed) {
      state.playback.elapsedMs = 0;
    }

    if (reason) {
      elements.statusLine.textContent = reason;
    }
  }

  function updateTransportUi() {
    const timelineDuration = state.currentTimeline?.durationMs ?? 0;
    const hasPreviewProgress =
      state.playback.elapsedMs > 0 || state.playback.isPlaying || state.playback.isPaused;
    const canScrubPreview =
      !state.playback.isPlaying && Boolean(state.currentTimeline) && state.lastKnownSequence.length > 0;
    elements.previewPlayToggle.textContent = state.playback.isPlaying
      ? "Pause Preview"
      : state.playback.isPaused
        ? "Resume Preview"
        : "Play Preview";
    elements.previewPlayToggle.disabled = !state.currentTimeline || !state.lastKnownSequence.length;
    elements.previewPauseToggle.textContent = "Reset";
    elements.previewPauseToggle.disabled =
      !state.currentTimeline ||
      !state.lastKnownSequence.length ||
      !hasPreviewProgress;
    elements.timelineCanvas.style.cursor = canScrubPreview
      ? state.playback.isScrubbing
        ? "grabbing"
        : "grab"
      : "default";
    elements.previewTimeLabel.textContent = `${formatSeconds(state.playback.elapsedMs)} / ${formatSeconds(timelineDuration)}`;
  }

  function updateScenarioNavigationUi() {
    const names = state.catalogNames;
    const currentIndex = names.indexOf(elements.scenarioSelect.value);
    const hasCatalog = names.length > 0;

    elements.scenarioPrev.disabled = !hasCatalog || (currentIndex !== -1 && currentIndex === 0);
    elements.scenarioNext.disabled =
      !hasCatalog || (currentIndex !== -1 && currentIndex === names.length - 1);
  }

  function updateActiveAudioIndicators(elapsedMs) {
    const nextActiveEventIds = new Set();
    for (const event of state.currentTimeline?.audioEvents ?? []) {
      if (elapsedMs >= event.anchorMs && elapsedMs <= event.anchorMs + event.durationMs) {
        nextActiveEventIds.add(event.id);
      }
    }
    state.playback.activeAudioEventIds = nextActiveEventIds;
  }

  function tickPreviewPlayback(nowMs) {
    if (!state.playback.isPlaying || !state.currentTimeline) {
      return;
    }

    state.playback.elapsedMs = getPlaybackElapsedMs(state, nowMs);
    updateActiveAudioIndicators(state.playback.elapsedMs);
    renderPreview();

    if (state.playback.elapsedMs >= state.currentTimeline.durationMs) {
      stopPreviewPlayback("Preview finished.", false);
      renderPreview();
      return;
    }

    state.playback.rafId = window.requestAnimationFrame(tickPreviewPlayback);
  }

  async function startPreviewPlayback() {
    if (!state.currentTimeline) {
      return;
    }

    stopPreviewPlayback("", true);
    let audioContext = null;
    try {
      audioContext = await ensureRunningAudioContext(state);
    } catch (_error) {
      elements.statusLine.textContent =
        "Browser blocked preview audio. The transport will still run silently.";
    }
    state.playback.isPlaying = true;
    state.playback.isPaused = false;
    state.playback.elapsedMs = 0;
    state.playback.startedAtMs = performance.now();
    state.playback.startedAtAudioTimeSec = audioContext ? audioContext.currentTime : NaN;
    if (audioContext) {
      schedulePreviewAudio(state, 0);
    }
    updateActiveAudioIndicators(0);
    updateTransportUi();
    renderPreview();
    state.playback.rafId = window.requestAnimationFrame(tickPreviewPlayback);
  }

  function pausePreviewPlayback() {
    if (!state.playback.isPlaying) {
      return;
    }

    state.playback.elapsedMs = getPlaybackElapsedMs(state);

    if (state.playback.rafId) {
      window.cancelAnimationFrame(state.playback.rafId);
      state.playback.rafId = 0;
    }

    stopScheduledAudio(state);
    state.playback.isPlaying = false;
    state.playback.isPaused = true;
    state.playback.startedAtAudioTimeSec = NaN;
    updateActiveAudioIndicators(state.playback.elapsedMs);
    renderPreview();
  }

  async function resumePreviewPlayback() {
    if (!state.currentTimeline || !state.playback.isPaused) {
      return;
    }

    let audioContext = null;
    try {
      audioContext = await ensureRunningAudioContext(state);
    } catch (_error) {
      elements.statusLine.textContent =
        "Browser blocked preview audio. The transport will still run silently.";
    }
    state.playback.isPaused = false;
    state.playback.isPlaying = true;
    state.playback.startedAtMs = performance.now() - state.playback.elapsedMs;
    state.playback.startedAtAudioTimeSec = audioContext
      ? audioContext.currentTime - state.playback.elapsedMs / 1000
      : NaN;
    if (audioContext) {
      schedulePreviewAudio(state, state.playback.elapsedMs);
    }
    updateActiveAudioIndicators(state.playback.elapsedMs);
    renderPreview();
    state.playback.rafId = window.requestAnimationFrame(tickPreviewPlayback);
  }

  function scrubPreviewPosition(clientX) {
    if (!state.currentTimeline) {
      return;
    }

    state.playback.elapsedMs = timelineTimeFromClientX(
      elements.timelineCanvas,
      state.currentTimeline,
      clientX
    );
    updateActiveAudioIndicators(state.playback.elapsedMs);
    renderPreview();
  }

  function renderPreview() {
    const timeline = state.currentTimeline ?? emptyTimeline;
    const waveformByAudioEventId = buildWaveformMap(state);
    renderMachineView(elements.machineCanvas, timeline, {
      playbackTimeMs: state.playback.elapsedMs,
      activeAudioEventIds: state.playback.activeAudioEventIds,
      isPlaying: state.playback.isPlaying || state.playback.isPaused
    });
    renderTimeline(elements.timelineCanvas, timeline, {
      playbackTimeMs: state.playback.elapsedMs,
      activeAudioEventIds: state.playback.activeAudioEventIds,
      waveformByAudioEventId
    });
    updateTransportUi();
  }

  const refresh = () => {
    const sequence = getCurrentSequence();
    state.lastKnownSequence = sequence;

    const timeline = computeTimeline(sequence, {
      soundDurations: state.soundDurations
    });
    state.currentTimeline = timeline;
    state.playback.elapsedMs = Math.min(state.playback.elapsedMs, timeline.durationMs);
    if (state.playback.isPlaying) {
      state.playback.elapsedMs = getPlaybackElapsedMs(state);
      schedulePreviewAudio(state, state.playback.elapsedMs);
      updateActiveAudioIndicators(state.playback.elapsedMs);
    } else if (state.playback.isPaused || state.playback.isScrubbing) {
      updateActiveAudioIndicators(state.playback.elapsedMs);
    }

    const sequenceText = serializeChoreography(sequence, { escapeQuotes: true });
    const jsonLine = buildJsonLine(elements.scenarioName.value, sequence);
    const diagnostics = [...state.parserDiagnostics, ...timeline.warnings];

    if (state.workspace) {
      syncServoBlockEstimates(state.workspace, timeline.servoEvents);
    }

    elements.sequenceOutput.value = sequenceText;
    elements.jsonLineOutput.value = jsonLine;
    elements.durationLabel.textContent = `${Math.round(timeline.durationMs)} ms`;
    elements.stepCountLabel.textContent = String(sequence.length);
    elements.audioCountLabel.textContent = String(timeline.audioEvents.length);
    elements.servoCountLabel.textContent = String(timeline.servoEvents.length);
    elements.statusLine.textContent = describeStatus({
      hasBlockly: state.hasBlockly,
      diagnostics,
      unresolvedAudioCount: timeline.audioEvents.filter((event) => !event.resolvedDuration).length,
      selectedName: elements.scenarioName.value.trim()
    });

    renderPreview();
    renderDiagnostics(elements.diagnosticsList, elements.diagnosticsCount, diagnostics);
    ensurePreloadedAudio(timeline.audioEvents);
    updateScenarioNavigationUi();

    dispatchChange(root, {
      name: elements.scenarioName.value.trim(),
      sequenceText,
      jsonLine,
      sequence,
      timeline,
      diagnostics
    });
  };

  const ensurePreloadedAudio = createAudioPreloader(state, refresh);

  function loadCatalogScenario(name) {
    if (!state.catalog || !name || !state.catalog[name]) {
      return false;
    }

    elements.scenarioSelect.value = name;
    elements.sourceText.value = state.catalog[name];
    importText(state.catalog[name], name);
    return true;
  }

  function shiftCatalogScenario(step) {
    const names = state.catalogNames;
    if (!names.length) {
      return;
    }

    const currentIndex = names.indexOf(elements.scenarioSelect.value);
    const targetIndex =
      currentIndex === -1
        ? step > 0
          ? 0
          : names.length - 1
        : Math.max(0, Math.min(names.length - 1, currentIndex + step));

    if (targetIndex === currentIndex) {
      return;
    }

    loadCatalogScenario(names[targetIndex]);
  }

  function getCurrentSequence() {
    return state.workspace ? workspaceToSequence(state.workspace) : state.lastKnownSequence;
  }

  function applySequenceToWorkspace(elementsToApply) {
    if (!state.workspace) {
      return;
    }

    state.isApplyingWorkspaceImport = true;
    try {
      sequenceToWorkspace(state.workspace, elementsToApply);
    } finally {
      state.isApplyingWorkspaceImport = false;
      resizeBlocklyWorkspace(state);
    }
  }

  function applySequence(elementsToApply) {
    state.lastKnownSequence = elementsToApply;
    applySequenceToWorkspace(elementsToApply);
    refresh();
  }

  function importText(input, explicitName = "") {
    stopPreviewPlayback();
    const extracted = extractEditorInput(input);
    const parseResult = parseChoreography(extracted.sequenceText);
    const hasErrors = parseResult.diagnostics.some((item) => item.level === "error");
    state.parserDiagnostics = parseResult.diagnostics;

    if (explicitName || extracted.name) {
      elements.scenarioName.value = explicitName || extracted.name;
    }

    if (!hasErrors) {
      applySequence(parseResult.elements);
      elements.statusLine.textContent = parseResult.elements.length
        ? `Imported ${parseResult.elements.length} step(s) into Blockly.`
        : "Imported an empty choreography.";
      return true;
    }

    renderDiagnostics(elements.diagnosticsList, elements.diagnosticsCount, parseResult.diagnostics);
    elements.statusLine.textContent =
      parseResult.diagnostics[0]?.message ||
      "Import hit parser errors. The existing workspace was left in place.";
    return false;
  }

  if (state.workspace) {
    applySequenceToWorkspace(state.lastKnownSequence);
    state.workspace.addChangeListener((event) => {
      if (event.type === window.Blockly.Events.UI || state.isApplyingWorkspaceImport) {
        return;
      }
      stopPreviewPlayback();
      refresh();
    });
  }

  elements.parseText.addEventListener("click", () => {
    importText(elements.sourceText.value);
  });

  elements.loadSample.addEventListener("click", () => {
    stopPreviewPlayback();
    elements.scenarioName.value = "calm_01230";
    elements.scenarioSelect.value = state.catalogNames.includes("calm_01230") ? "calm_01230" : "";
    state.parserDiagnostics = [];
    applySequence(defaultSequence());
  });

  elements.copySequence.addEventListener("click", async () => {
    await copyText(elements.sequenceOutput.value);
    elements.statusLine.textContent = "Copied the JSON-ready choreography value.";
  });

  elements.copyJsonLine.addEventListener("click", async () => {
    await copyText(elements.jsonLineOutput.value);
    elements.statusLine.textContent = "Copied the full JSON line.";
  });

  elements.scenarioName.addEventListener("input", refresh);
  elements.sourceText.addEventListener("input", () => {
    state.userTouchedSource = true;
  });
  elements.soundsBaseUrl.addEventListener("change", () => {
    stopPreviewPlayback();
    destroyPreloadedAudio(state);
    state.soundDurations.clear();
    refresh();
  });
  elements.previewPlayToggle.addEventListener("click", async () => {
    if (state.playback.isPlaying) {
      pausePreviewPlayback();
      return;
    }
    if (state.playback.isPaused) {
      await resumePreviewPlayback();
      return;
    }
    await startPreviewPlayback();
  });
  elements.previewPauseToggle.addEventListener("click", () => {
    stopPreviewPlayback("Preview reset.", true);
    renderPreview();
  });
  elements.scenarioPrev.addEventListener("click", () => {
    shiftCatalogScenario(-1);
  });
  elements.scenarioNext.addEventListener("click", () => {
    shiftCatalogScenario(1);
  });
  elements.timelineCanvas.addEventListener("pointerdown", (event) => {
    if (state.playback.isPlaying || !state.currentTimeline || !state.lastKnownSequence.length) {
      return;
    }

    state.playback.isPaused = true;
    state.playback.isPlaying = false;
    state.playback.isScrubbing = true;
    state.playback.scrubPointerId = event.pointerId;
    elements.timelineCanvas.setPointerCapture?.(event.pointerId);
    scrubPreviewPosition(event.clientX);
    event.preventDefault();
  });
  elements.timelineCanvas.addEventListener("pointermove", (event) => {
    if (!state.playback.isScrubbing || state.playback.scrubPointerId !== event.pointerId) {
      return;
    }

    scrubPreviewPosition(event.clientX);
  });
  const endTimelineScrub = (event) => {
    if (!state.playback.isScrubbing || state.playback.scrubPointerId !== event.pointerId) {
      return;
    }

    state.playback.isScrubbing = false;
    state.playback.scrubPointerId = null;
    elements.timelineCanvas.releasePointerCapture?.(event.pointerId);
    renderPreview();
  };
  elements.timelineCanvas.addEventListener("pointerup", endTimelineScrub);
  elements.timelineCanvas.addEventListener("pointercancel", endTimelineScrub);

  elements.scenarioSelect.addEventListener("change", () => {
    loadCatalogScenario(elements.scenarioSelect.value);
  });

  window.addEventListener("resize", () => {
    resizeBlocklyWorkspace(state);
    renderPreview();
  });

  loadChoreographyCatalog().then((catalog) => {
    state.catalog = catalog;
    state.catalogNames = [];
    if (!catalog) {
      refresh();
      elements.statusLine.textContent =
        "Catalog fetch failed; paste a sequence manually or serve the repo root so ../choreographies.json is reachable.";
      return;
    }

    const names = Object.keys(catalog).sort((a, b) => a.localeCompare(b));
    state.catalogNames = names;
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      elements.scenarioSelect.appendChild(option);
    }

    if (names.includes(DEFAULT_START_SCENARIO)) {
      if (!state.userTouchedSource) {
        loadCatalogScenario(DEFAULT_START_SCENARIO);
        return;
      }
    }

    state.parserDiagnostics = [];
    refresh();
  });

  refresh();
  resizeBlocklyWorkspace(state);

  return {
    loadChoreography({ name = "", sequenceText = "" } = {}) {
      if (name) {
        elements.scenarioName.value = name;
      }
      elements.sourceText.value = sequenceText;
      importText(sequenceText, name);
    },
    getState() {
      return {
        name: elements.scenarioName.value.trim(),
        sequenceText: elements.sequenceOutput.value,
        jsonLine: elements.jsonLineOutput.value,
        sequence: state.workspace ? workspaceToSequence(state.workspace) : state.lastKnownSequence
      };
    },
    refresh
  };
}

const root = document.querySelector("[data-editorv2-root]");
if (root) {
  window.LaMachineEditorV2 = mountEditorApp(root);
}
