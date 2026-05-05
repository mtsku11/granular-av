import { startTransition, useEffect, useId, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
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
import { bootGranularAV } from './runtime';
import './styles.css';

type AppState = 'idle' | 'starting' | 'ready' | 'error';

interface QualityOption {
  value: GranularQuality;
  label: string;
}

interface VisualModeOption {
  value: GranularVisualMode;
  label: string;
  description: string;
}

interface InputModeOption {
  value: GranularInputMode;
  label: string;
}

interface ControlSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  description: string;
  valueLabel: string;
  onChange: (value: number) => void;
}

const INITIAL_INTERACTION: InteractionState = {
  pointerX: 0.5,
  pointerY: 0.5,
  down: false,
  clickX: 0.5,
  clickY: 0.5,
  clickImpulse: 0,
};

const INITIAL_SETTINGS: GranularSettings = {
  intensity: 0.78,
  freeze: 0.08,
  quality: 'balanced',
  visualMode: 'clone',
};

const INITIAL_METRICS: GranularMetrics = {
  rms: 0,
  centroid: 0,
  fps: 0,
  activeGrains: 0,
};

const QUALITY_OPTIONS: QualityOption[] = [
  { value: 'performance', label: 'Lean' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detail', label: 'Detail' },
];

const VISUAL_MODE_OPTIONS: VisualModeOption[] = [
  { value: 'clone', label: 'Granular cloud', description: 'Scheduled Hann-windowed audio and video grains with non-local source scatter.' },
  { value: 'shuffle', label: 'Temporal shuffle', description: 'Both fields split into delayed lanes with wider spray and staggered echoes.' },
  { value: 'slitscan', label: 'Diagonal scan', description: 'Longer grains traverse the video buffer diagonally while the audio read-head leans into the same delayed motion.' },
];

const INPUT_MODE_OPTIONS: InputModeOption[] = [
  { value: 'camera', label: 'Camera + mic' },
  { value: 'file', label: 'Video file' },
  { value: 'display', label: 'Share tab' },
];

const FREEZE_TOGGLE_VALUE = 0.88;
const FREEZE_IDLE_VALUE = 0.08;

export default function GranularAVApp() {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<GranularAVEngine | null>(null);
  const interactionRef = useRef<InteractionState>({ ...INITIAL_INTERACTION });
  const settingsRef = useRef<GranularSettings>({ ...INITIAL_SETTINGS });
  const [appState, setAppState] = useState<AppState>('idle');
  const [startStatus, setStartStatus] = useState('Ready when you are.');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GranularMetrics>(INITIAL_METRICS);
  const [settings, setSettings] = useState<GranularSettings>(INITIAL_SETTINGS);
  const [inputMode, setInputMode] = useState<GranularInputMode>('camera');
  const [inputFile, setInputFile] = useState<File | null>(null);
  const [activeInputChoice, setActiveInputChoice] = useState<GranularInputChoice | null>(null);
  const [showControls, setShowControls] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    syncPointerVisual(shellRef.current, INITIAL_INTERACTION.pointerX, INITIAL_INTERACTION.pointerY, false);

    return () => {
      const engine = engineRef.current;
      if (!engine) return;
      engineRef.current = null;
      void engine.stop().catch((error) => {
        console.error('GranularAV stop failed during unmount.', error);
      });
    };
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isInteractiveTarget(event.target)) return;

      const key = event.key.toLowerCase();

      if (key === ' ') {
        event.preventDefault();
        setSettings((current) => ({
          ...current,
          freeze: current.freeze > 0.5 ? FREEZE_IDLE_VALUE : FREEZE_TOGGLE_VALUE,
        }));
        return;
      }

      if (key === 'r') {
        event.preventDefault();
        resetInstrument(engineRef, interactionRef, shellRef);
        return;
      }

      if (key === 'f') {
        event.preventDefault();
        void toggleFullscreen(shellRef);
        return;
      }

      if (key === 'd') {
        event.preventDefault();
        setShowDebug((current) => !current);
        return;
      }

      if (key === 'c') {
        event.preventDefault();
        setShowControls((current) => !current);
        return;
      }

      if (key === 'escape') {
        setShowControls(false);
        setShowDebug(false);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const startInstrument = async () => {
    if (appState === 'starting' || !canvasRef.current) return;
    if (inputMode === 'file' && !inputFile) {
      setAppState('error');
      setStartStatus('Video file required.');
      setErrorMessage('Choose a local video file before starting the instrument.');
      return;
    }

    const inputChoice: GranularInputChoice = {
      mode: inputMode,
      file: inputFile,
    };

    setAppState('starting');
    setStartStatus('Preparing audio…');
    setErrorMessage(null);

    try {
      if (engineRef.current) {
        await engineRef.current.stop();
        engineRef.current = null;
        setActiveInputChoice(null);
      }

      const engine = await bootGranularAV({
        canvas: canvasRef.current,
        interactionRef,
        settingsRef,
        inputChoice,
        onMetrics: (nextMetrics) => {
          startTransition(() => setMetrics(nextMetrics));
        },
        onStatus: (nextStatus) => {
          startTransition(() => setStartStatus(nextStatus));
        },
        onEnded: (runtimeError) => {
          engineRef.current = null;
          startTransition(() => {
            setActiveInputChoice(null);
            setMetrics(INITIAL_METRICS);
            setStartStatus(runtimeError.message);
            setErrorMessage(runtimeError.message);
            setAppState('error');
          });
        },
      });

      engineRef.current = engine;
      setActiveInputChoice(inputChoice);
      setShowControls(false);
      setStartStatus(`Instrument live · ${getSourceStatusLabel(inputMode, inputFile)}`);
      setAppState('ready');
    } catch (error) {
      setActiveInputChoice(null);
      setStartStatus('Start failed.');
      setErrorMessage(error instanceof Error ? error.message : 'Unable to start the selected input.');
      setAppState('error');
    }
  };

  const chooseInputMode = (mode: GranularInputMode) => {
    setInputMode(mode);
    setAppState((current) => (current === 'error' ? 'idle' : current));
    setErrorMessage(null);
    setStartStatus(getInputModeIdleStatus(mode, inputFile));
  };

  const selectVideoFile = (file: File | null) => {
    if (!file) {
      setInputFile(null);
      setErrorMessage(null);
      if (inputMode === 'file') {
        setStartStatus('Choose a local video file.');
      }
      return;
    }

    if (file.type && !file.type.startsWith('video/')) {
      setInputFile(null);
      setAppState('error');
      setStartStatus('File rejected.');
      setErrorMessage('That file is not a recognised video format.');
      return;
    }

    setInputFile(file);
    setAppState((current) => (current === 'error' ? 'idle' : current));
    setErrorMessage(null);
    setStartStatus(`Loaded ${file.name}`);
  };

  const updatePointer = (clientX: number, clientY: number, currentTarget: HTMLElement) => {
    const bounds = currentTarget.getBoundingClientRect();
    const x = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    const y = clamp((clientY - bounds.top) / bounds.height, 0, 1);
    interactionRef.current.pointerX = x;
    interactionRef.current.pointerY = y;
    syncPointerVisual(shellRef.current, x, y, interactionRef.current.down);
  };

  const triggerClickImpulse = () => {
    interactionRef.current.clickX = interactionRef.current.pointerX;
    interactionRef.current.clickY = interactionRef.current.pointerY;
    interactionRef.current.clickImpulse = 1;
    syncPointerVisual(
      shellRef.current,
      interactionRef.current.pointerX,
      interactionRef.current.pointerY,
      interactionRef.current.down,
      1,
    );
  };

  const statusLabel =
    appState === 'ready'
      ? 'Live'
      : appState === 'starting'
        ? 'Starting'
        : appState === 'error'
          ? 'Blocked'
          : 'Idle';

  const freezeLabel = settings.freeze >= 0.65 ? 'Latched' : settings.freeze >= 0.28 ? 'Cooling' : 'Open';
  const selectedSourceLabel = getSourceStatusLabel(inputMode, inputFile);
  const activeSourceLabel = activeInputChoice ? getSourceStatusLabel(activeInputChoice.mode, activeInputChoice.file ?? null) : selectedSourceLabel;
  const visualModeDescription = getVisualModeDescription(settings.visualMode);
  const overlayTitle = getOverlayTitle(inputMode);
  const overlayCopy = getOverlayCopy(inputMode);
  const sourceControlDescription = getSourceControlDescription(inputMode);
  const canStart = appState !== 'starting' && (inputMode !== 'file' || Boolean(inputFile));

  return (
    <div
      ref={shellRef}
      className="granular-av-shell"
      data-ready={appState === 'ready' ? 'true' : 'false'}
      data-pointer-visible={pointerInside || interactionRef.current.down ? 'true' : 'false'}
    >
      <input
        ref={fileInputRef}
        className="granular-av-file-picker__input"
        type="file"
        accept="video/*"
        onChange={(event) => {
          selectVideoFile(event.target.files?.[0] ?? null);
          event.currentTarget.value = '';
        }}
      />

      <canvas
        ref={canvasRef}
        className="granular-av-canvas"
        onPointerEnter={() => setPointerInside(true)}
        onPointerMove={(event) => updatePointer(event.clientX, event.clientY, event.currentTarget)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updatePointer(event.clientX, event.clientY, event.currentTarget);
          interactionRef.current.down = true;
          setPointerInside(true);
          triggerClickImpulse();
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          interactionRef.current.down = false;
          syncPointerVisual(
            shellRef.current,
            interactionRef.current.pointerX,
            interactionRef.current.pointerY,
            false,
          );
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          interactionRef.current.down = false;
          setPointerInside(false);
          syncPointerVisual(
            shellRef.current,
            interactionRef.current.pointerX,
            interactionRef.current.pointerY,
            false,
          );
        }}
        onPointerLeave={() => {
          interactionRef.current.down = false;
          setPointerInside(false);
          syncPointerVisual(
            shellRef.current,
            interactionRef.current.pointerX,
            interactionRef.current.pointerY,
            false,
          );
        }}
      />

      <div className="granular-av-atmosphere" aria-hidden="true" />
      <div className="granular-av-vignette" aria-hidden="true" />
      <div className="granular-av-reticle" aria-hidden="true">
        <span />
      </div>

      <header className="granular-av-hud">
        <div className="granular-av-badge">
          <p className="granular-av-kicker">GranularAV</p>
          <h1>AV instrument</h1>
          <p>{activeSourceLabel}</p>
        </div>

        <div className="granular-av-actions">
          <button
            type="button"
            className="granular-av-action"
            onClick={() => setShowDebug((current) => !current)}
            aria-pressed={showDebug}
          >
            Debug
          </button>
          <button
            type="button"
            className="granular-av-action"
            onClick={() => void toggleFullscreen(shellRef)}
          >
            {isFullscreen ? 'Window' : 'Fullscreen'}
          </button>
          <button
            type="button"
            className="granular-av-action granular-av-action--primary"
            onClick={() => setShowControls((current) => !current)}
            aria-expanded={showControls}
            aria-controls="granular-av-dock"
          >
            {showControls ? 'Hide controls' : 'Controls'}
          </button>
        </div>
      </header>

      <div className="granular-av-statusbar">
        <span>{statusLabel}</span>
        <span>{activeSourceLabel}</span>
        <span>Mode {getVisualModeLabel(settings.visualMode)}</span>
        <span>Intensity {Math.round(settings.intensity * 100)}</span>
        <span>Freeze {freezeLabel}</span>
      </div>

      <section className={`granular-av-overlay${appState === 'ready' ? ' granular-av-overlay--hidden' : ''}`}>
        <div className="granular-av-overlay__panel">
          <p className="granular-av-kicker">Input source</p>
          <h2>{overlayTitle}</h2>
          <p className="granular-av-overlay__copy">{overlayCopy}</p>
          <p className="granular-av-overlay__status">{startStatus}</p>

          <div className="granular-av-overlay__quality">
            <span>Source</span>
            <InputModeSelector inputMode={inputMode} onChange={chooseInputMode} />
          </div>

          {inputMode === 'file' ? (
            <div className="granular-av-file-picker">
              <button
                type="button"
                className="granular-av-action"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose file
              </button>
              <span className={`granular-av-file-picker__label${inputFile ? ' is-selected' : ''}`}>
                {inputFile ? inputFile.name : 'No file selected'}
              </span>
            </div>
          ) : null}

          <div className="granular-av-overlay__quality">
            <span>Visual mode</span>
            <VisualModeSelector settings={settings} setSettings={setSettings} />
          </div>

          <div className="granular-av-overlay__quality">
            <span>Quality</span>
            <QualitySelector settings={settings} setSettings={setSettings} />
          </div>

          <div className="granular-av-overlay__footer">
            <button
              type="button"
              className="granular-av-launch"
              onClick={() => void startInstrument()}
              disabled={!canStart}
            >
              {appState === 'ready' ? 'Restart instrument' : appState === 'starting' ? 'Opening inputs…' : 'Start instrument'}
            </button>
            <p className="granular-av-overlay__hint">`space` freeze, `r` reset, `f` fullscreen</p>
          </div>

          {errorMessage ? <p className="granular-av-error">{errorMessage}</p> : null}
        </div>
      </section>

      <aside className={`granular-av-debug${showDebug ? ' is-open' : ''}`} aria-hidden={!showDebug}>
        <div className="granular-av-debug__header">
          <p className="granular-av-kicker">Diagnostics</p>
          <button type="button" className="granular-av-action" onClick={() => setShowDebug(false)}>
            Close
          </button>
        </div>

        <div className="granular-av-debug__metrics">
          <MetricCard label="RMS" value={metrics.rms.toFixed(2)} />
          <MetricCard label="Centroid" value={metrics.centroid.toFixed(2)} />
          <MetricCard label="FPS" value={metrics.fps.toFixed(0)} />
          <MetricCard label="Grains" value={String(metrics.activeGrains)} />
        </div>

        <div className="granular-av-debug__group">
          <p className="granular-av-debug__label">Visual mode</p>
          <VisualModeSelector settings={settings} setSettings={setSettings} />
        </div>

        <div className="granular-av-debug__group">
          <p className="granular-av-debug__label">Quality</p>
          <QualitySelector settings={settings} setSettings={setSettings} />
        </div>

        <div className="granular-av-debug__group">
          <p className="granular-av-debug__label">Shortcuts</p>
          <div className="granular-av-shortcuts">
            <span>`space` freeze</span>
            <span>`r` reset</span>
            <span>`f` fullscreen</span>
            <span>`c` controls</span>
            <span>`d` debug</span>
          </div>
        </div>
      </aside>

      <section id="granular-av-dock" className={`granular-av-dock${showControls ? ' is-open' : ''}`}>
        <div className="granular-av-dock__handle">
          <button
            type="button"
            className="granular-av-handle"
            onClick={() => setShowControls((current) => !current)}
            aria-expanded={showControls}
            aria-controls="granular-av-dock"
          >
            {showControls ? 'Close controls' : 'Shape instrument'}
          </button>
        </div>

        <div className="granular-av-dock__panel">
          <div className="granular-av-controls">
            <div className="granular-av-control">
              <div className="granular-av-control__header granular-av-control__header--stacked">
                <div>
                  <p className="granular-av-control__label">Source</p>
                  <p className="granular-av-control__description">{sourceControlDescription}</p>
                </div>
              </div>
              <div className="granular-av-control__body">
                <InputModeSelector inputMode={inputMode} onChange={chooseInputMode} />
                {inputMode === 'file' ? (
                  <div className="granular-av-file-picker granular-av-file-picker--inline">
                    <button
                      type="button"
                      className="granular-av-action"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Choose file
                    </button>
                    <span className={`granular-av-file-picker__label${inputFile ? ' is-selected' : ''}`}>
                      {inputFile ? inputFile.name : 'No file selected'}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="granular-av-control">
              <div className="granular-av-control__header granular-av-control__header--stacked">
                <div>
                  <p className="granular-av-control__label">Visual mode</p>
                  <p className="granular-av-control__description">{visualModeDescription}</p>
                </div>
              </div>
              <div className="granular-av-control__body">
                <VisualModeSelector settings={settings} setSettings={setSettings} />
              </div>
            </div>
            <div className="granular-av-control">
              <div className="granular-av-control__header granular-av-control__header--stacked">
                <div>
                  <p className="granular-av-control__label">Quality</p>
                  <p className="granular-av-control__description">Internal capture and render density for the same effect.</p>
                </div>
              </div>
              <div className="granular-av-control__body">
                <QualitySelector settings={settings} setSettings={setSettings} />
              </div>
            </div>
            <ControlSlider
              label="Intensity"
              value={settings.intensity}
              min={0.2}
              max={1}
              step={0.01}
              description="How strongly grain density, temporal displacement, and contrast are pushed."
              valueLabel={`${Math.round(settings.intensity * 100)}%`}
              onChange={(intensity) => {
                setSettings((current) => ({ ...current, intensity }));
              }}
            />
            <ControlSlider
              label="Freeze"
              value={settings.freeze}
              min={0}
              max={1}
              step={0.01}
              description="How much the sound and image grains latch onto a held source moment."
              valueLabel={freezeLabel}
              onChange={(freeze) => {
                setSettings((current) => ({ ...current, freeze }));
              }}
            />
          </div>

          <div className="granular-av-dock__actions">
            <button
              type="button"
              className="granular-av-action granular-av-action--primary"
              onClick={() => void startInstrument()}
              disabled={!canStart}
            >
              {appState === 'ready' ? 'Restart' : appState === 'starting' ? 'Starting…' : 'Start'}
            </button>
            <button
              type="button"
              className="granular-av-action"
              onClick={() => {
                resetInstrument(engineRef, interactionRef, shellRef);
              }}
            >
              Reset field
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function InputModeSelector({
  inputMode,
  onChange,
}: {
  inputMode: GranularInputMode;
  onChange: (mode: GranularInputMode) => void;
}) {
  return (
    <div className="granular-av-segmented" role="group" aria-label="Input source">
      {INPUT_MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`granular-av-segment${inputMode === option.value ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
          aria-pressed={inputMode === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function QualitySelector({
  settings,
  setSettings,
}: {
  settings: GranularSettings;
  setSettings: Dispatch<SetStateAction<GranularSettings>>;
}) {
  return (
    <div className="granular-av-segmented" role="group" aria-label="Quality">
      {QUALITY_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`granular-av-segment${settings.quality === option.value ? ' is-active' : ''}`}
          onClick={() => {
            setSettings((current) => ({ ...current, quality: option.value }));
          }}
          aria-pressed={settings.quality === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function VisualModeSelector({
  settings,
  setSettings,
}: {
  settings: GranularSettings;
  setSettings: Dispatch<SetStateAction<GranularSettings>>;
}) {
  return (
    <div className="granular-av-segmented" role="group" aria-label="Visual mode">
      {VISUAL_MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`granular-av-segment${settings.visualMode === option.value ? ' is-active' : ''}`}
          onClick={() => {
            setSettings((current) => ({ ...current, visualMode: option.value }));
          }}
          aria-pressed={settings.visualMode === option.value}
          title={option.description}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ControlSlider({ label, value, min, max, step, description, valueLabel, onChange }: ControlSliderProps) {
  const sliderId = useId();
  const ratio = (value - min) / (max - min);

  const updateFromClientX = (clientX: number, element: HTMLDivElement) => {
    const bounds = element.getBoundingClientRect();
    const nextRatio = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    const nextValue = snap(min + (max - min) * nextRatio, min, max, step);
    onChange(nextValue);
  };

  return (
    <div className="granular-av-control">
      <div className="granular-av-control__header">
        <div>
          <p id={sliderId} className="granular-av-control__label">
            {label}
          </p>
          <p className="granular-av-control__description">{description}</p>
        </div>
        <span className="granular-av-control__value">{valueLabel}</span>
      </div>

      <div
        className="granular-av-slider"
        role="slider"
        tabIndex={0}
        aria-labelledby={sliderId}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={valueLabel}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromClientX(event.clientX, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateFromClientX(event.clientX, event.currentTarget);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            onChange(snap(value - step, min, max, step));
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            onChange(snap(value + step, min, max, step));
          } else if (event.key === 'Home') {
            event.preventDefault();
            onChange(min);
          } else if (event.key === 'End') {
            event.preventDefault();
            onChange(max);
          }
        }}
      >
        <div className="granular-av-slider__track" />
        <div className="granular-av-slider__fill" style={{ width: `${ratio * 100}%` }} />
        <div className="granular-av-slider__thumb" style={{ left: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="granular-av-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function resetInstrument(
  engineRef: MutableRefObject<GranularAVEngine | null>,
  interactionRef: MutableRefObject<InteractionState>,
  shellRef: MutableRefObject<HTMLDivElement | null>,
) {
  interactionRef.current = { ...INITIAL_INTERACTION };
  syncPointerVisual(shellRef.current, INITIAL_INTERACTION.pointerX, INITIAL_INTERACTION.pointerY, false);
  engineRef.current?.reset();
}

async function toggleFullscreen(shellRef: MutableRefObject<HTMLDivElement | null>) {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }

  if (shellRef.current) {
    await shellRef.current.requestFullscreen();
  }
}

function syncPointerVisual(
  element: HTMLDivElement | null,
  x: number,
  y: number,
  down: boolean,
  pulse = 0,
) {
  if (!element) return;
  element.style.setProperty('--granular-pointer-x', `${(x * 100).toFixed(3)}%`);
  element.style.setProperty('--granular-pointer-y', `${(y * 100).toFixed(3)}%`);
  element.style.setProperty('--granular-pointer-down', down ? '1' : '0');
  if (pulse > 0) {
    element.style.setProperty('--granular-pointer-pulse', pulse.toFixed(3));
    window.setTimeout(() => {
      element.style.setProperty('--granular-pointer-pulse', '0');
    }, 180);
  }
}

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, [role="slider"]'));
}

function getSourceStatusLabel(
  inputMode: GranularInputMode,
  inputFile: File | null,
) {
  if (inputMode === 'file') {
    return inputFile ? `File · ${inputFile.name}` : 'File · none selected';
  }
  if (inputMode === 'display') {
    return 'Share tab';
  }
  return 'Camera + mic';
}

function getInputModeIdleStatus(inputMode: GranularInputMode, inputFile: File | null) {
  if (inputMode === 'camera') {
    return 'Ready when you are.';
  }
  if (inputMode === 'file') {
    return inputFile ? `Loaded ${inputFile.name}` : 'Choose a local video file.';
  }
  return 'Pick a browser tab and enable share audio if the browser offers it.';
}

function getOverlayTitle(inputMode: GranularInputMode) {
  if (inputMode === 'camera') {
    return 'Camera and mic become the instrument.';
  }
  if (inputMode === 'file') {
    return 'Local movie becomes the instrument.';
  }
  return 'A shared browser tab becomes the instrument.';
}

function getOverlayCopy(inputMode: GranularInputMode) {
  if (inputMode === 'camera') {
    return 'Allow access, then drag to pull image time and grain density together. Headphones recommended.';
  }
  if (inputMode === 'file') {
    return 'Choose a local video file, then route its image and soundtrack through the same granular field. Nothing uploads anywhere.';
  }
  return 'Choose a browser tab in the share dialog, then enable share audio if it is offered. This is the practical route for YouTube or other web video.';
}

function getSourceControlDescription(inputMode: GranularInputMode) {
  if (inputMode === 'camera') {
    return 'Use live capture from the current device, then restart the engine if you change source.';
  }
  if (inputMode === 'file') {
    return 'Use a local movie file as the visual and audio source. The file stays on the machine.';
  }
  return 'Capture a browser tab or shared screen. Choose tab audio in the share dialog if you want sound.';
}

function getVisualModeLabel(visualMode: GranularVisualMode) {
  if (visualMode === 'shuffle') {
    return 'Temporal shuffle';
  }
  if (visualMode === 'slitscan') {
    return 'Diagonal scan';
  }
  return 'Granular cloud';
}

function getVisualModeDescription(visualMode: GranularVisualMode) {
  if (visualMode === 'shuffle') {
    return 'Split audio and video into delayed grain lanes, with density and spray widening both fields together.';
  }
  if (visualMode === 'slitscan') {
    return 'Use longer grains and diagonal history traversal, so the image scan and audio read-head share the same delayed direction.';
  }
  return 'Schedule short Hann-windowed audio and video grains together, then scatter and rotate the visual source positions from the same grain controls.';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snap(value: number, min: number, max: number, step: number) {
  const clamped = clamp(value, min, max);
  const snapped = Math.round((clamped - min) / step) * step + min;
  return Number(snapped.toFixed(4));
}
