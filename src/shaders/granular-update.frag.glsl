#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_feedback;
uniform sampler2D u_grainState;
uniform sampler2D u_history0;
uniform sampler2D u_history1;
uniform sampler2D u_history2;
uniform sampler2D u_history3;
uniform sampler2D u_history4;
uniform sampler2D u_history5;
uniform sampler2D u_history6;
uniform sampler2D u_history7;
uniform float u_historyNewest;
uniform vec2 u_resolution;
uniform vec2 u_grainStateResolution;
uniform vec2 u_pointer;
uniform vec2 u_click;
uniform float u_clickImpulse;
uniform float u_time;
uniform float u_rms;
uniform float u_centroid;
uniform float u_freeze;
uniform float u_intensity;
uniform float u_visualMode;
uniform float u_audioDensity;
uniform float u_audioGrainMs;
uniform float u_audioSprayMs;
uniform float u_audioPitchJitter;
uniform float u_historyMaxAge;

const int HISTORY_COUNT = 8;
const float PI = 3.14159265359;

struct GrainState {
  float isActive;
  float age;
  float duration;
  float sourceAge;
  float seed;
  float temporalWindow;
};

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  return vec2(
    hash12(p + vec2(1.37, 8.91)),
    hash12(p + vec2(5.17, 2.53))
  );
}

vec3 sampleHistory(int index, vec2 uv) {
  if (index == 0) return texture(u_history0, uv).rgb;
  if (index == 1) return texture(u_history1, uv).rgb;
  if (index == 2) return texture(u_history2, uv).rgb;
  if (index == 3) return texture(u_history3, uv).rgb;
  if (index == 4) return texture(u_history4, uv).rgb;
  if (index == 5) return texture(u_history5, uv).rgb;
  if (index == 6) return texture(u_history6, uv).rgb;
  return texture(u_history7, uv).rgb;
}

int resolveHistoryIndex(int age) {
  int newest = int(floor(u_historyNewest + 0.5));
  int slot = newest - age;
  if (slot < 0) {
    slot += HISTORY_COUNT;
  }
  return slot % HISTORY_COUNT;
}

vec3 sampleHistoryAge(float age, vec2 uv) {
  float clampedAge = clamp(age, 0.0, min(u_historyMaxAge, float(HISTORY_COUNT - 1)));
  int ageA = int(floor(clampedAge));
  int ageB = min(ageA + 1, HISTORY_COUNT - 1);
  float mixAmount = fract(clampedAge);
  vec3 sampleA = sampleHistory(resolveHistoryIndex(ageA), uv);
  vec3 sampleB = sampleHistory(resolveHistoryIndex(ageB), uv);
  return mix(sampleA, sampleB, mixAmount);
}

float hann(float x) {
  return 0.5 - 0.5 * cos(clamp(x, 0.0, 1.0) * PI * 2.0);
}

float hann2(vec2 local) {
  return hann(local.x) * hann(local.y);
}

vec2 rotateAround(vec2 point, vec2 center, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  vec2 p = point - center;
  return center + vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

GrainState readGrainState(vec2 cellId) {
  vec2 wrappedCell = mod(cellId, u_grainStateResolution);
  vec4 encoded = texture(u_grainState, (wrappedCell + 0.5) / u_grainStateResolution);
  float isActive = step(0.002, encoded.a) * step(encoded.r, 0.995);
  float duration = mix(0.025, 0.305, encoded.g);
  return GrainState(
    isActive,
    encoded.r,
    duration,
    encoded.b,
    encoded.a,
    hann(encoded.r) * isActive
  );
}

vec2 grainScatter(vec2 uv, vec2 cellId, GrainState grain, float localSpread, float nonLocalSpread) {
  vec2 nearMove = (hash22(cellId + grain.seed * 17.0) - 0.5) * localSpread;
  vec2 farTarget = hash22(cellId + vec2(grain.seed * 41.0, grain.seed * 67.0));
  float spraySpread = clamp(u_audioSprayMs / 130.0, 0.0, 1.0);
  float scatter = clamp(nonLocalSpread * (0.22 + spraySpread * 0.66 + u_intensity * 0.18 + u_clickImpulse * 0.24), 0.0, 0.92);
  return mix(uv + nearMove, farTarget, scatter);
}

vec4 cloudLayer(vec2 uv, vec2 gridOffset, float cellSize, float roughness, float delayBias) {
  vec2 gridUv = uv / cellSize + gridOffset;
  vec2 cellId = floor(gridUv);
  vec2 local = fract(gridUv);
  GrainState grain = readGrainState(cellId + gridOffset * 97.0);
  float spatialWindow = hann2(local);
  float window = spatialWindow * grain.temporalWindow;
  vec2 center = (cellId - gridOffset + 0.5) * cellSize;
  vec2 pointer = vec2(u_pointer.x, 1.0 - u_pointer.y);
  vec2 sourceUv = grainScatter(uv, cellId, grain, cellSize * (0.8 + roughness * 1.7), 0.82);
  float rotateAmount = (grain.seed - 0.5) * PI * (0.4 + u_audioPitchJitter * 8.0 + u_rms * 1.8);
  sourceUv = rotateAround(sourceUv, center, rotateAmount);

  float baseAge = grain.sourceAge * u_historyMaxAge;
  float delayA = clamp(delayBias + baseAge, 0.0, u_historyMaxAge);
  float delayB = clamp(delayA + 0.7 + hash12(cellId + vec2(2.0, 8.0)) * (1.3 + u_audioSprayMs / 70.0), 0.0, u_historyMaxAge);
  vec2 split = normalize((uv - pointer) + vec2(0.0001)) * cellSize * (0.22 + roughness * 0.52);

  vec3 grainA = sampleHistoryAge(delayA, clamp(sourceUv + split, 0.001, 0.999));
  vec3 grainB = sampleHistoryAge(delayB, clamp(sourceUv - split * 0.8, 0.001, 0.999));
  vec3 mixed = mix(grainA, grainB, 0.36 + grain.seed * 0.24);
  return vec4(mixed * window, window);
}

vec4 shuffleLayer(vec2 uv, vec2 gridOffset, float cellSize, float roughness) {
  vec2 gridUv = uv / cellSize + gridOffset;
  vec2 cellId = floor(gridUv);
  vec2 local = fract(gridUv);
  GrainState grain = readGrainState(cellId + vec2(11.0, 29.0) + gridOffset * 73.0);
  float spatialWindow = hann2(local);
  float window = spatialWindow * grain.temporalWindow;
  float lanes = mix(2.0, 3.0, smoothstep(0.32, 0.84, u_pointer.y + u_rms));
  float lane = floor(grain.seed * lanes);
  float sprayNorm = clamp(u_audioSprayMs / 130.0, 0.0, 1.0);
  float baseDelay = lane * mix(1.65, 3.05, sprayNorm);
  float jitterDelay = grain.sourceAge * (2.2 + u_audioPitchJitter * 5.2);
  float delay = clamp(baseDelay + jitterDelay, 0.0, u_historyMaxAge);
  vec2 sourceUv = grainScatter(uv, cellId, grain, cellSize * (1.0 + roughness), 0.56);
  vec2 laneOffset = vec2(lane - (lanes - 1.0) * 0.5, hash12(cellId + vec2(3.0, 15.0)) - 0.5);
  vec2 echoMove = laneOffset * cellSize * (1.0 + u_intensity * 1.6);
  vec3 current = sampleHistoryAge(delay, clamp(sourceUv, 0.001, 0.999));
  vec3 echo = sampleHistoryAge(clamp(delay + 1.6 + sprayNorm * 2.0, 0.0, u_historyMaxAge), clamp(sourceUv - echoMove, 0.001, 0.999));
  vec3 farEcho = sampleHistoryAge(clamp(delay + 3.6, 0.0, u_historyMaxAge), clamp(sourceUv + echoMove.yx * 0.8, 0.001, 0.999));
  vec3 shuffled = mix(current, echo, 0.34 + smoothstep(2.5, 3.0, lanes) * 0.16);
  shuffled = mix(shuffled, farEcho, smoothstep(2.5, 3.0, lanes) * (0.22 + u_freeze * 0.18));
  return vec4(shuffled * window, window);
}

vec4 scanLayer(vec2 uv, vec2 gridOffset, float cellSize, float roughness) {
  vec2 gridUv = uv / cellSize + gridOffset;
  vec2 cellId = floor(gridUv);
  vec2 local = fract(gridUv);
  GrainState grain = readGrainState(cellId + vec2(47.0, 5.0) + gridOffset * 53.0);
  float spatialWindow = hann2(local);
  float window = spatialWindow * grain.temporalWindow;
  float diagonal = clamp((uv.x * 0.7071 + (1.0 - uv.y) * 0.2929 + u_pointer.x * 0.22), 0.0, 1.0);
  float diagonalReadHead = clamp(diagonal + (u_pointer.x - 0.5) * 0.24, 0.0, 1.0);
  float audioReadHead = clamp(u_pointer.x + (grain.seed - 0.5) * 0.18 + grain.age * (0.12 + u_audioGrainMs / 520.0), 0.0, 1.0);
  float age = clamp(mix(mix(diagonalReadHead, audioReadHead, 0.42), grain.sourceAge, 0.34) * u_historyMaxAge, 0.0, u_historyMaxAge);
  vec2 center = (cellId - gridOffset + 0.5) * cellSize;
  vec2 traversedUv = rotateAround(uv, center, PI * 0.25 * (0.36 + u_intensity * 0.68));
  traversedUv.x += (age - u_historyMaxAge * 0.5) * cellSize * (0.24 + roughness * 0.7);
  traversedUv.y += (grain.seed - 0.5) * cellSize * (0.7 + u_audioSprayMs / 120.0);
  traversedUv = mix(traversedUv, grainScatter(uv, cellId, grain, cellSize * 0.8, 0.34), 0.22 + roughness * 0.16);
  vec3 sliceA = sampleHistoryAge(age, clamp(traversedUv, 0.001, 0.999));
  vec3 sliceB = sampleHistoryAge(clamp(age + 1.2 + u_audioSprayMs / 115.0, 0.0, u_historyMaxAge), clamp(uv, 0.001, 0.999));
  return vec4(mix(sliceA, sliceB, 0.2 + u_freeze * 0.24) * window, window);
}

void main() {
  vec2 uv = v_uv;
  vec2 pointer = vec2(u_pointer.x, 1.0 - u_pointer.y);
  vec2 click = vec2(u_click.x, 1.0 - u_click.y);
  float pointerDistance = distance(uv, pointer);
  float clickDistance = distance(uv, click);
  float pointerBloom = exp(-pointerDistance * 6.4) * (0.18 + u_rms * 0.4);
  float clickBloom = exp(-clickDistance * 12.0) * (0.12 + u_clickImpulse * 1.0);
  float localBloom = clamp(pointerBloom + clickBloom, 0.0, 1.0);
  float roughness = clamp(u_centroid * 0.9 + u_rms * 1.4 + localBloom * 0.8, 0.0, 1.0);
  float densityNorm = clamp((u_audioDensity - 4.0) / 32.0, 0.0, 1.0);
  float grainNorm = clamp(u_audioGrainMs / 180.0, 0.0, 1.0);
  float gridCount = mix(34.0, 9.0, grainNorm) + densityNorm * 8.0;
  float cellSize = 1.0 / gridCount;
  vec4 accumulated;
  float feedbackMix;
  float feedbackDecay;
  float feedbackDispAmount;

  if (u_visualMode < 0.5) {
    vec4 layerA = cloudLayer(uv, vec2(0.0), cellSize, roughness, 0.0);
    vec4 layerB = cloudLayer(uv, vec2(0.5), cellSize, roughness, 1.0);
    accumulated = layerA + layerB;
    feedbackMix = 0.16 + u_freeze * 0.36 + u_intensity * 0.16;
    feedbackDecay = 0.965 - roughness * 0.025;
    feedbackDispAmount = 0.004 + roughness * 0.014 + u_audioPitchJitter * 0.06;
  } else if (u_visualMode < 1.5) {
    vec4 layerA = shuffleLayer(uv, vec2(0.0), cellSize * 1.22, roughness);
    vec4 layerB = shuffleLayer(uv, vec2(0.5), cellSize * 1.22, roughness);
    accumulated = layerA + layerB;
    feedbackMix = 0.12 + u_freeze * 0.24 + u_intensity * 0.1;
    feedbackDecay = 0.954 - roughness * 0.02;
    feedbackDispAmount = 0.006 + roughness * 0.018;
  } else {
    vec4 layerA = scanLayer(uv, vec2(0.0), cellSize * 0.86, roughness);
    vec4 layerB = scanLayer(uv, vec2(0.5, 0.0), cellSize * 0.86, roughness);
    accumulated = layerA + layerB;
    feedbackMix = 0.2 + u_freeze * 0.26 + u_intensity * 0.08;
    feedbackDecay = 0.97 - roughness * 0.016;
    feedbackDispAmount = 0.01 + roughness * 0.012 + u_audioSprayMs * 0.00009;
  }

  float grainCoverage = clamp(accumulated.a, 0.0, 1.0);
  vec3 liveSource = sampleHistoryAge(0.0, uv);
  vec3 granularColour = accumulated.rgb / max(accumulated.a, 0.001);
  float grainEnergy = clamp(accumulated.a * (0.5 + densityNorm * 0.38), 0.0, 1.65);
  float visualAmplitude = 0.78 + grainEnergy * 0.22 + densityNorm * 0.12;
  float luma = dot(granularColour, vec3(0.299, 0.587, 0.114));
  granularColour = mix(vec3(luma), granularColour, 1.0 + grainEnergy * 0.16) * visualAmplitude;
  vec3 granular = mix(liveSource * (0.18 + u_intensity * 0.1), granularColour, grainCoverage);
  vec3 feedbackSeed = texture(u_feedback, uv).rgb;
  vec2 feedbackVector = clamp((feedbackSeed.rg - 0.5) * 2.0, -1.0, 1.0);
  vec2 radial = normalize((uv - mix(pointer, click, clamp(u_clickImpulse, 0.0, 1.0))) + vec2(0.0001));
  vec2 feedbackDisp = feedbackVector * feedbackDispAmount + radial * clickBloom * 0.01;
  vec3 feedback = texture(u_feedback, clamp(uv - feedbackDisp, 0.001, 0.999)).rgb * feedbackDecay;
  vec3 colour = mix(granular, feedback, clamp(feedbackMix, 0.0, 0.82));
  colour += vec3(0.08, 0.055, 0.02) * clickBloom + vec3(0.015, 0.04, 0.07) * pointerBloom;
  colour = mix(colour, colour.bgr * vec3(0.95, 1.02, 1.08), roughness * 0.12);
  colour *= 0.96 + localBloom * 0.22 + u_intensity * 0.08;
  outColor = vec4(colour, 1.0);
}
