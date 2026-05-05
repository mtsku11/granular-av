const MAX_GRAINS = 40;

class GranularProcessor extends AudioWorkletProcessor {
  buffer;
  writeHead = 0;
  grainCountdown = 0;
  grains;
  activeGrainCount = 0;
  params = {
    grainMs: 90,
    density: 12,
    sprayMs: 90,
    pitchJitter: 0.08,
    stereoSpread: 0.4,
    freeze: 0,
    intensity: 0.78,
    wet: 0.72,
    focusX: 0.5,
    focusY: 0.5,
    burst: 0,
    visualMode: 0,
  };
  freezeAnchor = 0;
  freezeLatched = false;
  meterCountdown = 0;
  stopping = false;

  constructor() {
    super();
    this.buffer = new Float32Array(Math.floor(globalThis.sampleRate * 4));
    this.grains = Array.from({ length: MAX_GRAINS }, () => ({
      startIndex: 0,
      duration: 1,
      position: 0,
      rate: 1,
      pan: 0,
      gain: 0,
    }));
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'params') {
        this.params = { ...this.params, ...message.params };
      }
      if (message?.type === 'reset') {
        this.buffer.fill(0);
        this.activeGrainCount = 0;
        this.grainCountdown = 0;
        this.freezeAnchor = 0;
        this.freezeLatched = false;
      }
      if (message?.type === 'stop') {
        this.stopping = true;
      }
    };
  }

  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  smoothstep(edge0, edge1, x) {
    const t = this.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  wrap(index) {
    const size = this.buffer.length;
    return ((index % size) + size) % size;
  }

  mixWrapped(a, b, t) {
    const size = this.buffer.length;
    let delta = b - a;
    if (delta > size * 0.5) delta -= size;
    if (delta < -size * 0.5) delta += size;
    return this.wrap(a + delta * t);
  }

  readBuffer(position) {
    const indexA = Math.floor(position);
    const indexB = this.wrap(indexA + 1);
    const frac = position - indexA;
    const sampleA = this.buffer[this.wrap(indexA)] ?? 0;
    const sampleB = this.buffer[indexB] ?? 0;
    return sampleA + (sampleB - sampleA) * frac;
  }

  spawnGrain() {
    if (this.activeGrainCount >= MAX_GRAINS) return;

    const duration = Math.max(24, Math.floor((this.params.grainMs / 1000) * globalThis.sampleRate));
    const mode = Math.round(this.params.visualMode);
    const baseDelayMs = 34 + (1 - this.params.focusY) * (mode === 2 ? 420 : 280);
    const sprayMs = this.params.sprayMs * (0.35 + this.params.intensity);
    const randomOffsetMs = (Math.random() * 2 - 1) * sprayMs;
    const shuffleLane = Math.floor(Math.random() * (mode === 1 ? 3 : 2));
    const laneDelayMs = mode === 1 ? shuffleLane * sprayMs * 0.72 : 0;
    const diagonalDelayMs = mode === 2 ? this.params.focusX * sprayMs * 1.6 : 0;
    const liveDelayMs = Math.max(12, baseDelayMs + randomOffsetMs + laneDelayMs + diagonalDelayMs);
    const freezeMix = this.smoothstep(0.08, 0.88, this.params.freeze);
    const freezeAnchorTarget = this.wrap(
      this.writeHead - Math.floor((baseDelayMs + sprayMs * 0.4) * globalThis.sampleRate / 1000),
    );

    if (freezeMix < 0.16) {
      this.freezeAnchor = freezeAnchorTarget;
      this.freezeLatched = false;
    } else if (!this.freezeLatched) {
      this.freezeAnchor = freezeAnchorTarget;
      this.freezeLatched = true;
    }

    const liveStart = this.wrap(
      this.writeHead
      - Math.floor(liveDelayMs * globalThis.sampleRate / 1000)
      - duration,
    );
    const frozenStart = this.wrap(this.freezeAnchor - duration * 0.5 + randomOffsetMs * 0.18);
    const startIndex = this.mixWrapped(liveStart, frozenStart, freezeMix);
    const rateBase = mode === 2
      ? 0.82 + this.params.focusX * 0.34
      : 1 + (this.params.focusX - 0.5) * 0.42;
    const rate = this.clamp(rateBase + (Math.random() * 2 - 1) * this.params.pitchJitter, 0.45, 1.8);
    const pan = this.clamp(
      (this.params.focusX * 2 - 1) * this.params.stereoSpread + (Math.random() * 2 - 1) * 0.15,
      -1,
      1,
    );
    const gain = (mode === 0 ? 0.13 : 0.15 + Math.random() * 0.05) * (0.48 + this.params.intensity * 0.46);

    const grain = this.grains[this.activeGrainCount];
    this.activeGrainCount += 1;
    grain.startIndex = startIndex;
    grain.duration = duration;
    grain.position = 0;
    grain.rate = rate;
    grain.pan = pan;
    grain.gain = gain;
  }

  removeGrain(index) {
    const lastIndex = this.activeGrainCount - 1;
    if (lastIndex < 0) return;
    if (index !== lastIndex) {
      const target = this.grains[index];
      const last = this.grains[lastIndex];
      target.startIndex = last.startIndex;
      target.duration = last.duration;
      target.position = last.position;
      target.rate = last.rate;
      target.pan = last.pan;
      target.gain = last.gain;
    }
    this.activeGrainCount = lastIndex;
  }

  softClip(value) {
    return Math.tanh(value * 1.1);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const outputLeft = outputs[0]?.[0];
    const outputRight = outputs[0]?.[1] ?? outputLeft;
    if (!outputLeft || !outputRight) return true;

    const density = this.clamp(this.params.density, 2, 36);
    const spawnInterval = Math.max(8, Math.floor(globalThis.sampleRate / density));
    const wetMix = this.clamp(this.params.wet, 0, 1);
    const dryMix = 1 - wetMix * 0.78;
    const overlapTarget = Math.max(1, density * this.params.grainMs / 1000);
    const wetTrim = (0.7 + this.params.intensity * 0.18) / Math.sqrt(overlapTarget);

    for (let sampleIndex = 0; sampleIndex < outputLeft.length; sampleIndex += 1) {
      const inputSample = input?.[sampleIndex] ?? 0;
      this.buffer[this.writeHead] = inputSample;
      this.writeHead = this.wrap(this.writeHead + 1);

      this.grainCountdown -= 1;
      if (this.grainCountdown <= 0) {
        this.spawnGrain();
        if (Math.round(this.params.visualMode) === 0 && Math.random() < 0.46 + this.params.intensity * 0.18) {
          this.spawnGrain();
        }
        if (Math.round(this.params.visualMode) === 1 && Math.random() < 0.28 + this.params.focusY * 0.22) {
          this.spawnGrain();
        }
        if (this.params.burst > 0.45 && Math.random() < this.params.burst * 0.4) {
          this.spawnGrain();
        }
        this.grainCountdown = spawnInterval;
      }

      let left = 0;
      let right = 0;
      for (let grainIndex = this.activeGrainCount - 1; grainIndex >= 0; grainIndex -= 1) {
        const grain = this.grains[grainIndex];
        const progress = grain.position / grain.duration;
        if (progress >= 1) {
          this.removeGrain(grainIndex);
          continue;
        }

        const envelope = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2);
        const sample = this.readBuffer(grain.startIndex + grain.position * grain.rate);
        const amplitude = sample * envelope * grain.gain;
        const panLeft = Math.cos((grain.pan * 0.5 + 0.5) * Math.PI * 0.5);
        const panRight = Math.sin((grain.pan * 0.5 + 0.5) * Math.PI * 0.5);

        left += amplitude * panLeft;
        right += amplitude * panRight;
        grain.position += 1;
      }

      const wetLeft = left * wetTrim;
      const wetRight = right * wetTrim;
      outputLeft[sampleIndex] = this.softClip(inputSample * dryMix + wetLeft * wetMix);
      outputRight[sampleIndex] = this.softClip(inputSample * dryMix + wetRight * wetMix);
    }

    this.meterCountdown += outputLeft.length;
    if (this.meterCountdown >= 2048) {
      this.port.postMessage({ type: 'meter', activeGrains: this.activeGrainCount });
      this.meterCountdown = 0;
    }

    return !(this.stopping && this.activeGrainCount === 0 && !input);
  }
}

registerProcessor('granular-av-processor', GranularProcessor);
