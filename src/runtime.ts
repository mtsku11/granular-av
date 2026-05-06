import type { MutableRefObject } from 'react';
import type {
  GranularAVEngine,
  GranularInputChoice,
  GranularInputMode,
  GranularMetrics,
  GranularQuality,
  GranularSettings,
  GranularVisualMode,
  InteractionState,
} from './model';
import vertSrc from './shaders/fullscreen.vert.glsl?raw';
import grainStateSrc from './shaders/grain-state.frag.glsl?raw';
import updateSrc from './shaders/granular-update.frag.glsl?raw';
import displaySrc from './shaders/display.frag.glsl?raw';

interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  interactionRef: MutableRefObject<InteractionState>;
  settingsRef: MutableRefObject<GranularSettings>;
  inputChoice: GranularInputChoice;
  onMetrics: (metrics: GranularMetrics) => void;
  onStatus?: (status: string) => void;
  onEnded?: (error: Error) => void;
}

interface TexturePair {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface QualityPreset {
  captureWidth: number;
  captureHeight: number;
  renderWidth: number;
  renderHeight: number;
  grainStateWidth: number;
  grainStateHeight: number;
  historyUploadIntervalMs: number;
}

interface GranularInputSession {
  mode: GranularInputMode;
  label: string;
  videoElement: HTMLVideoElement;
  hasAudio: boolean;
  connectAudioSource: (audioContext: AudioContext) => AudioNode | null;
  start: () => Promise<void>;
  setHidden: (hidden: boolean) => Promise<void> | void;
  subscribeToEnded: (onEnded: (message: string) => void) => () => void;
  stop: () => Promise<void>;
}

interface FullscreenQuad {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
}

interface GranularShape {
  density: number;
  grainMs: number;
  sprayMs: number;
  pitchJitter: number;
  stereoSpread: number;
  wet: number;
  burst: number;
}

const HISTORY_SLOTS = 8;
const MAX_DPR = 1.5;
const ANALYSER_INTERVAL_MS = 50;
const PARAM_POST_INTERVAL_MS = 33;
const SHADER_TIME_WRAP_MS = 100_000;
const VISUAL_FREEZE_ON = 0.55;
const VISUAL_FREEZE_OFF = 0.18;
const WORKLET_LOAD_TIMEOUT_MS = 5_000;
const VIDEO_PLAY_TIMEOUT_MS = 4_000;
const workletModuleUrl = new URL('./audio/granular-processor.worklet.js', import.meta.url).href;

const QUALITY_PRESETS: Record<GranularQuality, QualityPreset> = {
  performance: {
    captureWidth: 640,
    captureHeight: 360,
    renderWidth: 426,
    renderHeight: 240,
    grainStateWidth: 40,
    grainStateHeight: 23,
    historyUploadIntervalMs: 66,
  },
  balanced: {
    captureWidth: 960,
    captureHeight: 540,
    renderWidth: 640,
    renderHeight: 360,
    grainStateWidth: 56,
    grainStateHeight: 32,
    historyUploadIntervalMs: 50,
  },
  detail: {
    captureWidth: 1280,
    captureHeight: 720,
    renderWidth: 960,
    renderHeight: 540,
    grainStateWidth: 80,
    grainStateHeight: 45,
    historyUploadIntervalMs: 33,
  },
};

export async function bootGranularAV({
  canvas,
  interactionRef,
  settingsRef,
  inputChoice,
  onMetrics,
  onStatus,
  onEnded,
}: RuntimeOptions): Promise<GranularAVEngine> {
  const initialPreset = getQualityPreset(settingsRef.current);
  let inputSession: GranularInputSession | null = null;
  let audioContext: AudioContext | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let updateProgram: WebGLProgram | null = null;
  let grainStateProgram: WebGLProgram | null = null;
  let displayProgram: WebGLProgram | null = null;
  let fullscreenQuad: FullscreenQuad | null = null;
  const historyTextures: WebGLTexture[] = [];
  const feedbackPairs: TexturePair[] = [];
  const grainStatePairs: TexturePair[] = [];

  try {
    onStatus?.('Preparing audio…');
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await resumeAudioContext(audioContext);

    onStatus?.('Loading audio engine…');
    await promiseWithTimeout(
      audioContext.audioWorklet.addModule(workletModuleUrl),
      WORKLET_LOAD_TIMEOUT_MS,
      'Audio engine failed to load. Reload and try again.',
    );
    await resumeAudioContext(audioContext);

    inputSession = await createInputSession(inputChoice, initialPreset, onStatus);
    const video = inputSession.videoElement;

    const glContext = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!glContext) {
      throw new Error('WebGL2 is unavailable in this browser.');
    }
    gl = glContext;
    const uploadCanvas = document.createElement('canvas');
    const uploadContext = uploadCanvas.getContext('2d', { alpha: false });
    if (!uploadContext) {
      throw new Error('Unable to create the internal video downsample buffer.');
    }

    const nextGrainStateProgram = createProgram(glContext, vertSrc, grainStateSrc, 'GranularAV grain state');
    const nextUpdateProgram = createProgram(glContext, vertSrc, updateSrc, 'GranularAV update');
    const nextDisplayProgram = createProgram(glContext, vertSrc, displaySrc, 'GranularAV display');
    const nextFullscreenQuad = createFullscreenQuad(glContext, nextGrainStateProgram, nextUpdateProgram, nextDisplayProgram);
    grainStateProgram = nextGrainStateProgram;
    updateProgram = nextUpdateProgram;
    displayProgram = nextDisplayProgram;
    fullscreenQuad = nextFullscreenQuad;

    historyTextures.push(...Array.from({ length: HISTORY_SLOTS }, () => createVideoTexture(glContext)));
    feedbackPairs.push(createFeedbackPair(glContext, 1, 1), createFeedbackPair(glContext, 1, 1));
    grainStatePairs.push(
      createGrainStatePair(glContext, initialPreset.grainStateWidth, initialPreset.grainStateHeight),
      createGrainStatePair(glContext, initialPreset.grainStateWidth, initialPreset.grainStateHeight),
    );
    let feedbackReadIndex = 0;
    let grainStateReadIndex = 0;
    let grainStateWidth = initialPreset.grainStateWidth;
    let grainStateHeight = initialPreset.grainStateHeight;
    let historyWriteIndex = 0;
    let historyPrimed = false;
    let shouldClearFeedback = true;
    let shouldClearGrainState = true;
    await resumeAudioContext(audioContext);

    const source = inputSession.connectAudioSource(audioContext);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;

    const workletNode = new AudioWorkletNode(audioContext, 'granular-av-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const outputGain = audioContext.createGain();
    outputGain.gain.value = 0.9;

    if (!source || !inputSession.hasAudio) {
      onStatus?.(`${inputSession.label} has no audio track. Visual granulation only.`);
    }

    source?.connect(analyser);
    source?.connect(workletNode);
    workletNode.connect(outputGain);
    outputGain.connect(audioContext.destination);
    await inputSession.start();
    const activeAudioContext = audioContext;
    const activeInputSession = inputSession;

    let activeGrains = 0;
    workletNode.port.onmessage = (event: MessageEvent<{ type?: string; activeGrains?: number }>) => {
      if (event.data?.type === 'meter') {
        activeGrains = event.data.activeGrains ?? activeGrains;
      }
    };

    const timeDomain = new Float32Array(analyser.fftSize);
    const frequencyDomain = new Uint8Array(analyser.frequencyBinCount);

    const grainStateUniforms = {
      previousState: glContext.getUniformLocation(nextGrainStateProgram, 'u_previousState'),
      stateResolution: glContext.getUniformLocation(nextGrainStateProgram, 'u_stateResolution'),
      pointer: glContext.getUniformLocation(nextGrainStateProgram, 'u_pointer'),
      time: glContext.getUniformLocation(nextGrainStateProgram, 'u_time'),
      deltaTime: glContext.getUniformLocation(nextGrainStateProgram, 'u_deltaTime'),
      rms: glContext.getUniformLocation(nextGrainStateProgram, 'u_rms'),
      centroid: glContext.getUniformLocation(nextGrainStateProgram, 'u_centroid'),
      freeze: glContext.getUniformLocation(nextGrainStateProgram, 'u_freeze'),
      intensity: glContext.getUniformLocation(nextGrainStateProgram, 'u_intensity'),
      visualMode: glContext.getUniformLocation(nextGrainStateProgram, 'u_visualMode'),
      audioDensity: glContext.getUniformLocation(nextGrainStateProgram, 'u_audioDensity'),
      audioGrainMs: glContext.getUniformLocation(nextGrainStateProgram, 'u_audioGrainMs'),
      audioSprayMs: glContext.getUniformLocation(nextGrainStateProgram, 'u_audioSprayMs'),
      audioPitchJitter: glContext.getUniformLocation(nextGrainStateProgram, 'u_audioPitchJitter'),
      clickImpulse: glContext.getUniformLocation(nextGrainStateProgram, 'u_clickImpulse'),
      freezeSourceAge: glContext.getUniformLocation(nextGrainStateProgram, 'u_freezeSourceAge'),
    };
    const updateUniforms = {
      feedback: glContext.getUniformLocation(nextUpdateProgram, 'u_feedback'),
      grainState: glContext.getUniformLocation(nextUpdateProgram, 'u_grainState'),
      grainStateResolution: glContext.getUniformLocation(nextUpdateProgram, 'u_grainStateResolution'),
      history: Array.from({ length: HISTORY_SLOTS }, (_, index) => glContext.getUniformLocation(nextUpdateProgram, `u_history${index}`)),
      historyNewest: glContext.getUniformLocation(nextUpdateProgram, 'u_historyNewest'),
      resolution: glContext.getUniformLocation(nextUpdateProgram, 'u_resolution'),
      pointer: glContext.getUniformLocation(nextUpdateProgram, 'u_pointer'),
      click: glContext.getUniformLocation(nextUpdateProgram, 'u_click'),
      clickImpulse: glContext.getUniformLocation(nextUpdateProgram, 'u_clickImpulse'),
      time: glContext.getUniformLocation(nextUpdateProgram, 'u_time'),
      rms: glContext.getUniformLocation(nextUpdateProgram, 'u_rms'),
      centroid: glContext.getUniformLocation(nextUpdateProgram, 'u_centroid'),
      freeze: glContext.getUniformLocation(nextUpdateProgram, 'u_freeze'),
      intensity: glContext.getUniformLocation(nextUpdateProgram, 'u_intensity'),
      visualMode: glContext.getUniformLocation(nextUpdateProgram, 'u_visualMode'),
      audioDensity: glContext.getUniformLocation(nextUpdateProgram, 'u_audioDensity'),
      audioGrainMs: glContext.getUniformLocation(nextUpdateProgram, 'u_audioGrainMs'),
      audioSprayMs: glContext.getUniformLocation(nextUpdateProgram, 'u_audioSprayMs'),
      audioPitchJitter: glContext.getUniformLocation(nextUpdateProgram, 'u_audioPitchJitter'),
      interactionActive: glContext.getUniformLocation(nextUpdateProgram, 'u_interactionActive'),
      historyMaxAge: glContext.getUniformLocation(nextUpdateProgram, 'u_historyMaxAge'),
    };
    const displayUniforms = {
      scene: glContext.getUniformLocation(nextDisplayProgram, 'u_scene'),
      resolution: glContext.getUniformLocation(nextDisplayProgram, 'u_resolution'),
      time: glContext.getUniformLocation(nextDisplayProgram, 'u_time'),
    };

    glContext.useProgram(nextGrainStateProgram);
    glContext.uniform1i(grainStateUniforms.previousState, 0);

    glContext.useProgram(nextUpdateProgram);
    glContext.uniform1i(updateUniforms.feedback, 0);
    glContext.uniform1i(updateUniforms.grainState, 9);
    updateUniforms.history.forEach((uniform, index) => {
      glContext.uniform1i(uniform, 1 + index);
    });

    glContext.useProgram(nextDisplayProgram);
    glContext.uniform1i(displayUniforms.scene, 0);
    glContext.bindVertexArray(nextFullscreenQuad.vao);

    let renderWidth = 1;
    let renderHeight = 1;
    let lastHistoryUpload = Number.NEGATIVE_INFINITY;
    let lastAnalyserUpdate = Number.NEGATIVE_INFINITY;
    let lastParamPost = Number.NEGATIVE_INFINITY;
    let cachedRms = 0;
    let cachedCentroid = 0;

    const allocateHistoryTextures = () => {
      for (const texture of historyTextures) {
        glContext.bindTexture(glContext.TEXTURE_2D, texture);
        glContext.texImage2D(glContext.TEXTURE_2D, 0, glContext.RGBA, renderWidth, renderHeight, 0, glContext.RGBA, glContext.UNSIGNED_BYTE, null);
      }
      uploadContext.fillStyle = '#000';
      uploadContext.fillRect(0, 0, renderWidth, renderHeight);
      glContext.pixelStorei(glContext.UNPACK_FLIP_Y_WEBGL, 1);
      for (const texture of historyTextures) {
        glContext.bindTexture(glContext.TEXTURE_2D, texture);
        glContext.texSubImage2D(glContext.TEXTURE_2D, 0, 0, 0, glContext.RGBA, glContext.UNSIGNED_BYTE, uploadCanvas);
      }
      historyWriteIndex = 0;
      historyPrimed = false;
      lastHistoryUpload = Number.NEGATIVE_INFINITY;
    };

    const resize = () => {
      const preset = getQualityPreset(settingsRef.current);
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      const nextRenderSize = getRenderSize(width, height, preset);
      if (
        canvas.width === width
        && canvas.height === height
        && renderWidth === nextRenderSize.width
        && renderHeight === nextRenderSize.height
      ) {
        return;
      }

      canvas.width = width;
      canvas.height = height;
      renderWidth = nextRenderSize.width;
      renderHeight = nextRenderSize.height;
      uploadCanvas.width = renderWidth;
      uploadCanvas.height = renderHeight;
      for (const pair of feedbackPairs) {
        glContext.bindTexture(glContext.TEXTURE_2D, pair.texture);
        glContext.texImage2D(glContext.TEXTURE_2D, 0, glContext.RGBA8, renderWidth, renderHeight, 0, glContext.RGBA, glContext.UNSIGNED_BYTE, null);
      }
      if (grainStateWidth !== preset.grainStateWidth || grainStateHeight !== preset.grainStateHeight) {
        grainStateWidth = preset.grainStateWidth;
        grainStateHeight = preset.grainStateHeight;
        resizeGrainStatePairs(glContext, grainStatePairs, grainStateWidth, grainStateHeight);
        shouldClearGrainState = true;
      }
      allocateHistoryTextures();
      shouldClearFeedback = true;
      shouldClearGrainState = true;
    };

    const clearPairs = (pairs: TexturePair[], width: number, height: number, alpha = 1) => {
      for (const pair of pairs) {
        glContext.bindFramebuffer(glContext.FRAMEBUFFER, pair.framebuffer);
        glContext.viewport(0, 0, width, height);
        glContext.clearColor(0, 0, 0, alpha);
        glContext.clear(glContext.COLOR_BUFFER_BIT);
      }
      glContext.bindFramebuffer(glContext.FRAMEBUFFER, null);
    };

    const resetFeedback = () => {
      clearPairs(feedbackPairs, renderWidth, renderHeight);
      shouldClearFeedback = false;
    };

    const resetGrainState = () => {
      clearPairs(grainStatePairs, grainStateWidth, grainStateHeight, 0);
      shouldClearGrainState = false;
      grainStateReadIndex = 0;
    };

    const updateVideoTextures = (now: number, holdHistory: boolean) => {
      if (holdHistory) return;
      const preset = getQualityPreset(settingsRef.current);
      if (now - lastHistoryUpload < preset.historyUploadIntervalMs) return;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      uploadContext.drawImage(video, 0, 0, renderWidth, renderHeight);
      glContext.pixelStorei(glContext.UNPACK_FLIP_Y_WEBGL, 1);

      if (!historyPrimed) {
        for (let index = 0; index < HISTORY_SLOTS; index += 1) {
          glContext.activeTexture(glContext.TEXTURE1 + index);
          glContext.bindTexture(glContext.TEXTURE_2D, historyTextures[index]);
          glContext.texSubImage2D(glContext.TEXTURE_2D, 0, 0, 0, glContext.RGBA, glContext.UNSIGNED_BYTE, uploadCanvas);
        }
        historyWriteIndex = 0;
        historyPrimed = true;
      } else {
        const texture = historyTextures[historyWriteIndex];
        glContext.activeTexture(glContext.TEXTURE1 + historyWriteIndex);
        glContext.bindTexture(glContext.TEXTURE_2D, texture);
        glContext.texSubImage2D(glContext.TEXTURE_2D, 0, 0, 0, glContext.RGBA, glContext.UNSIGNED_BYTE, uploadCanvas);
        historyWriteIndex = (historyWriteIndex + 1) % HISTORY_SLOTS;
      }

      lastHistoryUpload = now;
    };

    const updateAudioMetrics = (now: number) => {
      if (now - lastAnalyserUpdate < ANALYSER_INTERVAL_MS) return;
      if (!source || !inputSession?.hasAudio) {
        cachedRms = 0;
        cachedCentroid = 0;
        lastAnalyserUpdate = now;
        return;
      }
      analyser.getFloatTimeDomainData(timeDomain);
      analyser.getByteFrequencyData(frequencyDomain);
      cachedRms = computeRms(timeDomain);
      cachedCentroid = computeSpectralCentroid(frequencyDomain);
      lastAnalyserUpdate = now;
    };

    const postWorkletParams = (
      now: number,
      interaction: InteractionState,
      settings: GranularSettings,
      freeze: number,
      rms: number,
      centroid: number,
    ) => {
      if (now - lastParamPost < PARAM_POST_INTERVAL_MS && interaction.clickImpulse < 0.8) return;

      const shape = getGranularShape(interaction, settings, freeze, rms, centroid);
      const interactionActive = getInteractionActive(interaction);

      workletNode.port.postMessage({
        type: 'params',
        params: {
          grainMs: shape.grainMs,
          density: shape.density,
          sprayMs: shape.sprayMs,
          pitchJitter: shape.pitchJitter,
          stereoSpread: shape.stereoSpread,
          freeze,
          intensity: settings.intensity,
          wet: shape.wet,
          focusX: interaction.pointerX,
          focusY: interaction.pointerY,
          burst: shape.burst,
          visualMode: getVisualModeValue(settings.visualMode),
          interactionActive,
          liveMonitor: activeInputSession.mode === 'camera' ? 0 : 1,
        },
      });
      lastParamPost = now;
    };

    let rafId = 0;
    let stopped = false;
    let lastFrame = performance.now();
    let lastMetricsPush = 0;
    let visualFreezeLatched = false;
    let visualFreezeSourceAge = 0;
    let stopPromise: Promise<void> | null = null;

    const loop = (now: number) => {
      if (stopped) return;
      resize();
      if (shouldClearFeedback) resetFeedback();
      if (shouldClearGrainState) resetGrainState();
      updateAudioMetrics(now);

      const rms = cachedRms;
      const centroid = cachedCentroid;
      const interaction = interactionRef.current;
      const settings = settingsRef.current;
      const interactionActive = getInteractionActive(interaction);
      const freeze = clamp(settings.freeze + (interaction.down ? 0.22 : 0) + interaction.clickImpulse * 0.18, 0, 1);
      const shape = getGranularShape(interaction, settings, freeze, rms, centroid);
      const preset = getQualityPreset(settings);
      const freezeSourceAgeTarget = getVisualFreezeSourceAge(interaction, settings, shape, preset);
      if (freeze < VISUAL_FREEZE_OFF) {
        visualFreezeLatched = false;
        visualFreezeSourceAge = freezeSourceAgeTarget;
      } else if (!visualFreezeLatched && freeze >= VISUAL_FREEZE_ON) {
        visualFreezeLatched = true;
        visualFreezeSourceAge = freezeSourceAgeTarget;
      }

      updateVideoTextures(now, visualFreezeLatched && freeze >= VISUAL_FREEZE_OFF);
      postWorkletParams(now, interaction, settings, freeze, rms, centroid);
      const shaderTime = now % SHADER_TIME_WRAP_MS;
      const frameDt = clamp((now - lastFrame) / 1000, 1 / 120, 1 / 15);

      const writePair = feedbackPairs[(feedbackReadIndex + 1) % 2];
      const readPair = feedbackPairs[feedbackReadIndex];
      const grainStateWritePair = grainStatePairs[(grainStateReadIndex + 1) % 2];
      const grainStateReadPair = grainStatePairs[grainStateReadIndex];

      glContext.bindVertexArray(nextFullscreenQuad.vao);

      glContext.bindFramebuffer(glContext.FRAMEBUFFER, grainStateWritePair.framebuffer);
      glContext.viewport(0, 0, grainStateWidth, grainStateHeight);
      glContext.useProgram(nextGrainStateProgram);
      glContext.activeTexture(glContext.TEXTURE0);
      glContext.bindTexture(glContext.TEXTURE_2D, grainStateReadPair.texture);
      glContext.uniform2f(grainStateUniforms.stateResolution, grainStateWidth, grainStateHeight);
      glContext.uniform2f(grainStateUniforms.pointer, interaction.pointerX, interaction.pointerY);
      glContext.uniform1f(grainStateUniforms.time, shaderTime);
      glContext.uniform1f(grainStateUniforms.deltaTime, frameDt);
      glContext.uniform1f(grainStateUniforms.rms, rms);
      glContext.uniform1f(grainStateUniforms.centroid, centroid);
      glContext.uniform1f(grainStateUniforms.freeze, freeze);
      glContext.uniform1f(grainStateUniforms.intensity, settings.intensity);
      glContext.uniform1f(grainStateUniforms.visualMode, getVisualModeValue(settings.visualMode));
      glContext.uniform1f(grainStateUniforms.audioDensity, shape.density);
      glContext.uniform1f(grainStateUniforms.audioGrainMs, shape.grainMs);
      glContext.uniform1f(grainStateUniforms.audioSprayMs, shape.sprayMs);
      glContext.uniform1f(grainStateUniforms.audioPitchJitter, shape.pitchJitter);
      glContext.uniform1f(grainStateUniforms.clickImpulse, interaction.clickImpulse);
      glContext.uniform1f(grainStateUniforms.freezeSourceAge, visualFreezeSourceAge);
      glContext.drawArrays(glContext.TRIANGLES, 0, 3);

      glContext.bindFramebuffer(glContext.FRAMEBUFFER, writePair.framebuffer);
      glContext.viewport(0, 0, renderWidth, renderHeight);
      glContext.useProgram(nextUpdateProgram);
      glContext.activeTexture(glContext.TEXTURE0);
      glContext.bindTexture(glContext.TEXTURE_2D, readPair.texture);
      for (let index = 0; index < HISTORY_SLOTS; index += 1) {
        glContext.activeTexture(glContext.TEXTURE1 + index);
        glContext.bindTexture(glContext.TEXTURE_2D, historyTextures[index]);
      }
      glContext.activeTexture(glContext.TEXTURE9);
      glContext.bindTexture(glContext.TEXTURE_2D, grainStateWritePair.texture);
      const newestHistoryIndex = (historyWriteIndex + HISTORY_SLOTS - 1) % HISTORY_SLOTS;
      glContext.uniform2f(updateUniforms.resolution, renderWidth, renderHeight);
      glContext.uniform2f(updateUniforms.grainStateResolution, grainStateWidth, grainStateHeight);
      glContext.uniform1f(updateUniforms.historyNewest, newestHistoryIndex);
      glContext.uniform2f(updateUniforms.pointer, interaction.pointerX, interaction.pointerY);
      glContext.uniform2f(updateUniforms.click, interaction.clickX, interaction.clickY);
      glContext.uniform1f(updateUniforms.clickImpulse, interaction.clickImpulse);
      glContext.uniform1f(updateUniforms.time, shaderTime);
      glContext.uniform1f(updateUniforms.rms, rms);
      glContext.uniform1f(updateUniforms.centroid, centroid);
      glContext.uniform1f(updateUniforms.freeze, freeze);
      glContext.uniform1f(updateUniforms.intensity, settings.intensity);
      glContext.uniform1f(updateUniforms.visualMode, getVisualModeValue(settings.visualMode));
      glContext.uniform1f(updateUniforms.audioDensity, shape.density);
      glContext.uniform1f(updateUniforms.audioGrainMs, shape.grainMs);
      glContext.uniform1f(updateUniforms.audioSprayMs, shape.sprayMs);
      glContext.uniform1f(updateUniforms.audioPitchJitter, shape.pitchJitter);
      glContext.uniform1f(updateUniforms.interactionActive, interactionActive);
      glContext.uniform1f(updateUniforms.historyMaxAge, HISTORY_SLOTS - 1);
      glContext.drawArrays(glContext.TRIANGLES, 0, 3);

      glContext.bindFramebuffer(glContext.FRAMEBUFFER, null);
      glContext.viewport(0, 0, canvas.width, canvas.height);
      glContext.useProgram(nextDisplayProgram);
      glContext.activeTexture(glContext.TEXTURE0);
      glContext.bindTexture(glContext.TEXTURE_2D, writePair.texture);
      glContext.uniform2f(displayUniforms.resolution, canvas.width, canvas.height);
      glContext.uniform1f(displayUniforms.time, shaderTime);
      glContext.drawArrays(glContext.TRIANGLES, 0, 3);

      feedbackReadIndex = (feedbackReadIndex + 1) % 2;
      grainStateReadIndex = (grainStateReadIndex + 1) % 2;
      interaction.clickImpulse *= interaction.down ? 0.97 : 0.92;

      const dt = Math.max(1, now - lastFrame);
      const fps = 1000 / dt;
      if (now - lastMetricsPush > 120) {
        onMetrics({
          rms,
          centroid,
          fps,
          activeGrains,
        });
        lastMetricsPush = now;
      }
      lastFrame = now;
      rafId = window.requestAnimationFrame(loop);
    };

    const onResize = () => resize();
    const onVisibilityChange = () => {
      const hidden = document.hidden;
      shouldClearFeedback = true;
      void Promise.resolve(activeInputSession.setHidden(hidden)).catch(() => {});
      if (hidden) {
        void activeAudioContext.suspend();
        return;
      }

      if (activeAudioContext.state === 'suspended') {
        void activeAudioContext.resume().catch(() => {});
      }
    };
    const detachInputEnded = activeInputSession.subscribeToEnded((message) => {
      if (stopped) return;
      const runtimeError = new Error(message);
      onStatus?.(message);
      void shutdown()
        .catch((cleanupError) => {
          console.error('GranularAV cleanup failed after input ended.', cleanupError);
        })
        .finally(() => {
          onEnded?.(runtimeError);
        });
    });

    const shutdown = async () => {
      if (stopPromise) {
        return stopPromise;
      }

      stopPromise = (async () => {
        stopped = true;
        detachInputEnded();
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.cancelAnimationFrame(rafId);

        const cleanupErrors: Error[] = [];
        const collectCleanupError = (error: unknown, fallbackMessage: string) => {
          cleanupErrors.push(error instanceof Error ? error : new Error(fallbackMessage));
        };

        try {
          workletNode.port.postMessage({ type: 'reset' });
          workletNode.port.postMessage({ type: 'stop' });
        } catch (error) {
          collectCleanupError(error, 'Unable to stop the audio engine.');
        }

        try {
          workletNode.disconnect();
        } catch (error) {
          collectCleanupError(error, 'Unable to disconnect the audio engine output.');
        }
        try {
          analyser.disconnect();
        } catch (error) {
          collectCleanupError(error, 'Unable to disconnect the analyser.');
        }
        try {
          outputGain.disconnect();
        } catch (error) {
          collectCleanupError(error, 'Unable to disconnect the output gain.');
        }
        try {
          source?.disconnect();
        } catch (error) {
          collectCleanupError(error, 'Unable to disconnect the input source.');
        }

        try {
          await activeInputSession.stop();
        } catch (error) {
          collectCleanupError(error, `Unable to stop ${activeInputSession.label}.`);
        }

        try {
          if (activeAudioContext.state !== 'closed') {
            await activeAudioContext.close();
          }
        } catch (error) {
          collectCleanupError(error, 'Unable to close the audio context.');
        }

        destroyGraphicsResources(glContext, {
          feedbackPairs,
          grainStatePairs,
          historyTextures,
          grainStateProgram: nextGrainStateProgram,
          updateProgram: nextUpdateProgram,
          displayProgram: nextDisplayProgram,
          fullscreenQuad: nextFullscreenQuad,
        });

        if (cleanupErrors.length > 0) {
          throw cleanupErrors[0];
        }
      })();

      return stopPromise;
    };

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    resize();
    onStatus?.(`Instrument live · ${inputSession.label}`);
    rafId = window.requestAnimationFrame(loop);

    return {
      reset: () => {
        shouldClearFeedback = true;
        shouldClearGrainState = true;
        lastHistoryUpload = Number.NEGATIVE_INFINITY;
        interactionRef.current.clickImpulse = 0;
        workletNode.port.postMessage({ type: 'reset' });
      },
      stop: shutdown,
    };
  } catch (error) {
    destroyGraphicsResources(gl, {
      feedbackPairs,
      grainStatePairs,
      historyTextures,
      grainStateProgram,
      updateProgram,
      displayProgram,
      fullscreenQuad,
    });
    await inputSession?.stop().catch(() => {});
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close().catch(() => {});
    }
    throw toRuntimeError(error, inputChoice);
  }
}

async function createInputSession(
  inputChoice: GranularInputChoice,
  preset: QualityPreset,
  onStatus?: (status: string) => void,
): Promise<GranularInputSession> {
  if (inputChoice.mode === 'camera') {
    return createCameraSession(preset, onStatus);
  }

  if (inputChoice.mode === 'file') {
    if (!inputChoice.file) {
      throw new Error('Choose a local video file before starting the instrument.');
    }
    return createFileSession(inputChoice.file, onStatus);
  }

  if (inputChoice.mode === 'display') {
    return createDisplaySession(preset, onStatus);
  }

  throw new Error('Unsupported input mode.');
}

async function createCameraSession(preset: QualityPreset, onStatus?: (status: string) => void): Promise<GranularInputSession> {
  onStatus?.('Requesting camera + mic…');
  const preferredVideoConstraints: MediaTrackConstraints = {
    facingMode: 'user',
    width: { ideal: preset.captureWidth },
    height: { ideal: preset.captureHeight },
  };
  const preferredAudioConstraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: preferredVideoConstraints,
      audio: preferredAudioConstraints,
    });
  } catch (error) {
    if (!isMediaConstraintError(error)) {
      throw error;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: preset.captureWidth },
          height: { ideal: preset.captureHeight },
        },
        audio: true,
      });
    } catch (fallbackError) {
      if (!isMediaConstraintError(fallbackError)) {
        throw fallbackError;
      }
      onStatus?.('Mic unavailable, using camera only…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: preset.captureWidth },
          height: { ideal: preset.captureHeight },
        },
        audio: false,
      });
    }
  }

  onStatus?.('Opening live input…');
  const video = createHiddenVideoElement();
  video.muted = true;
  video.srcObject = stream;
  await playVideoElement(video, 'Camera preview failed to start. Try reloading the page.');
  const hasAudio = stream.getAudioTracks().length > 0;

  return {
    mode: 'camera',
    label: 'Camera + mic',
    videoElement: video,
    hasAudio,
    connectAudioSource: (audioContext) => (hasAudio ? audioContext.createMediaStreamSource(stream) : null),
    start: () => playVideoElement(video, 'Camera preview failed to start. Try reloading the page.'),
    setHidden: (hidden) => {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = !hidden;
      });
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !hidden;
      });
      if (hidden) {
        video.pause();
        return;
      }
      return playVideoElement(video, 'Camera preview failed to resume.');
    },
    subscribeToEnded: createStreamEndedSubscription(
      stream,
      'Camera input ended. Reconnect the device or click start again.',
    ),
    stop: async () => {
      stream.getTracks().forEach((track) => track.stop());
      video.pause();
      video.srcObject = null;
    },
  };
}

function isMediaConstraintError(error: unknown) {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === 'NotFoundError'
    || error.name === 'OverconstrainedError'
    || error.name === 'ConstraintNotSatisfiedError'
  );
}

async function createFileSession(file: File, onStatus?: (status: string) => void): Promise<GranularInputSession> {
  onStatus?.(`Opening ${file.name}…`);
  const objectUrl = URL.createObjectURL(file);
  const video = createHiddenVideoElement();
  video.loop = true;
  video.muted = false;
  video.src = objectUrl;
  video.load();

  try {
    await waitForVideoReady(video, `Unable to read “${file.name}”. Try a different video file.`);
  } catch (error) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  const hasAudio = detectMediaElementAudio(video);

  return {
    mode: 'file',
    label: file.name,
    videoElement: video,
    hasAudio,
    connectAudioSource: (audioContext) => (hasAudio ? audioContext.createMediaElementSource(video) : null),
    start: () => playVideoElement(video, `Video file failed to start. Try “${file.name}” again.`),
    setHidden: (hidden) => {
      if (hidden) {
        video.pause();
        return;
      }
      return playVideoElement(video, `Video file failed to resume. Try “${file.name}” again.`);
    },
    subscribeToEnded: () => () => {},
    stop: async () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

async function createDisplaySession(
  preset: QualityPreset,
  onStatus?: (status: string) => void,
): Promise<GranularInputSession> {
  onStatus?.('Choose a browser tab to share…');
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: preset.captureWidth },
      height: { ideal: preset.captureHeight },
      frameRate: { ideal: 30, max: 60 },
    },
    audio: true,
  });

  if (stream.getVideoTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('No video arrived from the shared tab. Try again and choose a tab to share.');
  }

  onStatus?.('Opening shared tab…');
  const video = createHiddenVideoElement();
  video.muted = true;
  video.srcObject = stream;
  await playVideoElement(video, 'Shared tab preview failed to start. Try sharing the tab again.');
  const hasAudio = stream.getAudioTracks().length > 0;

  return {
    mode: 'display',
    label: 'Shared tab',
    videoElement: video,
    hasAudio,
    connectAudioSource: (audioContext) => (hasAudio ? audioContext.createMediaStreamSource(stream) : null),
    start: () => playVideoElement(video, 'Shared tab preview failed to start. Try sharing the tab again.'),
    setHidden: (hidden) => {
      if (hidden) {
        video.pause();
        return;
      }
      return playVideoElement(video, 'Shared tab preview failed to resume.');
    },
    subscribeToEnded: createStreamEndedSubscription(
      stream,
      'Shared tab ended. Choose a tab to share and start again.',
    ),
    stop: async () => {
      stream.getTracks().forEach((track) => track.stop());
      video.pause();
      video.srcObject = null;
    },
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
  }
}

async function resumeAudioContext(audioContext: AudioContext) {
  if (audioContext.state === 'running') return;
  await audioContext.resume();
  if (audioContext.state === 'closed' || audioContext.state === 'suspended' || audioContext.state === 'interrupted') {
    throw new Error('Audio output is still suspended. Click start again to unlock it.');
  }
}

function createHiddenVideoElement() {
  const video = document.createElement('video');
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  return video;
}

async function playVideoElement(video: HTMLVideoElement, message: string) {
  await promiseWithTimeout(video.play(), VIDEO_PLAY_TIMEOUT_MS, message);
}

async function waitForVideoReady(video: HTMLVideoElement, message: string) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

  await new Promise<void>((resolve, reject) => {
    let timeoutId = 0;
    const cleanup = () => {
      video.removeEventListener('loadeddata', handleReady);
      video.removeEventListener('canplay', handleReady);
      video.removeEventListener('error', handleError);
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(message));
    };

    timeoutId = window.setTimeout(handleError, VIDEO_PLAY_TIMEOUT_MS);
    video.addEventListener('loadeddata', handleReady);
    video.addEventListener('canplay', handleReady);
    video.addEventListener('error', handleError);
  });
}

function detectMediaElementAudio(video: HTMLVideoElement) {
  const audioProbe = video as HTMLVideoElement & {
    audioTracks?: { length: number };
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
  };

  if (typeof audioProbe.mozHasAudio === 'boolean') {
    return audioProbe.mozHasAudio;
  }
  if (typeof audioProbe.audioTracks?.length === 'number') {
    return audioProbe.audioTracks.length > 0;
  }
  if (typeof audioProbe.webkitAudioDecodedByteCount === 'number') {
    if (audioProbe.webkitAudioDecodedByteCount > 0) {
      return true;
    }
  }
  return true;
}

function createStreamEndedSubscription(stream: MediaStream, message: string) {
  return (onEnded: (message: string) => void) => {
    let settled = false;
    const notifyEnded = () => {
      if (settled) return;
      settled = true;
      onEnded(message);
    };
    const handleTrackEnded = () => notifyEnded();
    const handleInactive = () => notifyEnded();

    stream.addEventListener('inactive', handleInactive);
    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', handleTrackEnded);
    });

    return () => {
      stream.removeEventListener('inactive', handleInactive);
      stream.getTracks().forEach((track) => {
        track.removeEventListener('ended', handleTrackEnded);
      });
    };
  };
}

function toRuntimeError(error: unknown, inputChoice: GranularInputChoice) {
  if (error instanceof Error && error.message) return error;
  return new Error(`Unable to start ${describeInputMode(inputChoice.mode)}.`);
}

function describeInputMode(mode: GranularInputMode) {
  if (mode === 'camera') return 'camera and microphone';
  if (mode === 'file') return 'video file';
  return 'shared tab input';
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * clamp(t, 0, 1);
}

function getGranularShape(
  interaction: InteractionState,
  settings: GranularSettings,
  freeze: number,
  rms: number,
  centroid: number,
): GranularShape {
  const mode = getVisualModeValue(settings.visualMode);
  const density = lerp(7, 30, interaction.pointerY) * (0.72 + settings.intensity * 0.42 + freeze * 0.1);
  const grainMs = lerp(36, 172, interaction.pointerX) * (1 + freeze * 0.16);
  const sprayMs = lerp(12, 118, interaction.pointerY) * (0.58 + centroid * 0.92 + interaction.clickImpulse * 0.28);
  const pitchJitter = lerp(0.006, 0.115, centroid + interaction.clickImpulse * 0.14);

  return {
    density: mode === 0 ? density * 1.18 : mode === 1 ? density * 0.92 : density * 0.72,
    grainMs: mode === 0 ? grainMs * 0.88 : mode === 1 ? grainMs : grainMs * 1.35,
    sprayMs: mode === 0 ? sprayMs * 0.78 : mode === 1 ? sprayMs * 1.28 : sprayMs * 1.55,
    pitchJitter: mode === 2 ? pitchJitter * 0.62 : pitchJitter,
    stereoSpread: lerp(0.18, 0.85, Math.abs(interaction.pointerX - 0.5) * 2),
    wet: clamp(0.42 + settings.intensity * 0.34 + freeze * 0.18 + rms * 0.12, 0.38, 0.9),
    burst: Math.max(interaction.clickImpulse, rms * 0.2),
  };
}

function getVisualFreezeSourceAge(
  interaction: InteractionState,
  settings: GranularSettings,
  shape: GranularShape,
  preset: QualityPreset,
) {
  const mode = getVisualModeValue(settings.visualMode);
  const baseDelayMs = 34 + (1 - interaction.pointerY) * (mode === 2 ? 420 : 280);
  const anchorDelayMs = baseDelayMs + shape.sprayMs * 0.4;
  const historySpanMs = Math.max(1, preset.historyUploadIntervalMs * (HISTORY_SLOTS - 1));
  return clamp(anchorDelayMs / historySpanMs, 0, 1);
}

function getInteractionActive(interaction: InteractionState) {
  return clamp((interaction.down ? 1 : 0) + interaction.clickImpulse * 0.65, 0, 1);
}

function getQualityPreset(settings: GranularSettings) {
  return QUALITY_PRESETS[settings.quality] ?? QUALITY_PRESETS.balanced;
}

function getVisualModeValue(visualMode: GranularVisualMode) {
  if (visualMode === 'shuffle') return 1;
  if (visualMode === 'slitscan') return 2;
  return 0;
}

function getRenderSize(width: number, height: number, preset: QualityPreset) {
  const aspect = width / Math.max(1, height);
  let renderWidth = Math.max(1, Math.round(Math.sqrt(preset.renderWidth * preset.renderHeight * aspect)));
  let renderHeight = Math.max(1, Math.round(renderWidth / aspect));

  if (renderWidth > preset.renderWidth) {
    renderWidth = preset.renderWidth;
    renderHeight = Math.max(1, Math.round(renderWidth / aspect));
  }

  if (renderHeight > preset.renderHeight) {
    renderHeight = preset.renderHeight;
    renderWidth = Math.max(1, Math.round(renderHeight * aspect));
  }

  return { width: renderWidth, height: renderHeight };
}

function computeRms(data: Float32Array) {
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index] ?? 0;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 3.5);
}

function computeSpectralCentroid(data: Uint8Array) {
  let weighted = 0;
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index] / 255;
    weighted += value * index;
    sum += value;
  }
  if (sum === 0) return 0;
  return clamp(weighted / sum / data.length, 0, 1);
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string, label: string) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label} vertex`);
  let fragmentShader: WebGLShader | null = null;
  let program: WebGLProgram | null = null;

  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);
    program = gl.createProgram();
    if (!program) {
      throw new Error(`Unable to create ${label} program.`);
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) ?? 'Unknown link error';
      throw new Error(`${label} failed to link: ${info}`);
    }

    return program;
  } catch (error) {
    if (program) {
      gl.deleteProgram(program);
    }
    throw error;
  } finally {
    gl.deleteShader(vertexShader);
    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, label: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Unable to create ${label} shader.`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'Unknown compile error';
    gl.deleteShader(shader);
    throw new Error(`${label} failed to compile: ${info}`);
  }
  return shader;
}

function createFullscreenQuad(gl: WebGL2RenderingContext, ...programs: WebGLProgram[]): FullscreenQuad {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Unable to create fullscreen quad.');
  const vbo = gl.createBuffer();
  if (!vbo) {
    gl.deleteVertexArray(vao);
    throw new Error('Unable to create fullscreen quad.');
  }

  try {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const program of programs) {
      const location = gl.getAttribLocation(program, 'a_position');
      if (location < 0) {
        throw new Error('Unable to bind fullscreen quad attributes.');
      }
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    }
    return { vao, vbo };
  } catch (error) {
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    throw error;
  }
}

function createVideoTexture(gl: WebGL2RenderingContext) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Unable to create video texture.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255]),
  );
  return texture;
}

function createFeedbackPair(gl: WebGL2RenderingContext, width: number, height: number): TexturePair {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture) throw new Error('Unable to create feedback framebuffer.');
  if (!framebuffer) {
    gl.deleteTexture(texture);
    throw new Error('Unable to create feedback framebuffer.');
  }

  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { texture, framebuffer };
  } catch (error) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw error;
  }
}

function createGrainStatePair(gl: WebGL2RenderingContext, width: number, height: number): TexturePair {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture) throw new Error('Unable to create visual grain state.');
  if (!framebuffer) {
    gl.deleteTexture(texture);
    throw new Error('Unable to create visual grain state.');
  }

  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { texture, framebuffer };
  } catch (error) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw error;
  }
}

function resizeGrainStatePairs(gl: WebGL2RenderingContext, pairs: TexturePair[], width: number, height: number) {
  for (const pair of pairs) {
    gl.bindTexture(gl.TEXTURE_2D, pair.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
}

function destroyGraphicsResources(
  gl: WebGL2RenderingContext | null,
  resources: {
    feedbackPairs: TexturePair[];
    grainStatePairs: TexturePair[];
    historyTextures: WebGLTexture[];
    grainStateProgram: WebGLProgram | null;
    updateProgram: WebGLProgram | null;
    displayProgram: WebGLProgram | null;
    fullscreenQuad: FullscreenQuad | null;
  },
) {
  if (!gl) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindVertexArray(null);
  gl.useProgram(null);

  resources.feedbackPairs.forEach((pair) => {
    gl.deleteFramebuffer(pair.framebuffer);
    gl.deleteTexture(pair.texture);
  });
  resources.grainStatePairs.forEach((pair) => {
    gl.deleteFramebuffer(pair.framebuffer);
    gl.deleteTexture(pair.texture);
  });
  resources.historyTextures.forEach((texture) => gl.deleteTexture(texture));

  if (resources.fullscreenQuad) {
    gl.deleteVertexArray(resources.fullscreenQuad.vao);
    gl.deleteBuffer(resources.fullscreenQuad.vbo);
  }
  if (resources.updateProgram) {
    gl.deleteProgram(resources.updateProgram);
  }
  if (resources.grainStateProgram) {
    gl.deleteProgram(resources.grainStateProgram);
  }
  if (resources.displayProgram) {
    gl.deleteProgram(resources.displayProgram);
  }
}
