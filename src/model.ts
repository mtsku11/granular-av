export type GranularQuality = 'performance' | 'balanced' | 'detail';
export type GranularVisualMode = 'clone' | 'shuffle' | 'slitscan';
export type GranularInputMode = 'camera' | 'file' | 'display';

export interface GranularInputChoice {
  mode: GranularInputMode;
  file?: File | null;
}

export interface InteractionState {
  pointerX: number;
  pointerY: number;
  down: boolean;
  clickX: number;
  clickY: number;
  clickImpulse: number;
}

export interface GranularSettings {
  intensity: number;
  freeze: number;
  quality: GranularQuality;
  visualMode: GranularVisualMode;
}

export interface GranularMetrics {
  rms: number;
  centroid: number;
  fps: number;
  activeGrains: number;
}

export interface GranularAVEngine {
  reset: () => void;
  stop: () => Promise<void>;
}
