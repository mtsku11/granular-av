#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_previousState;
uniform vec2 u_stateResolution;
uniform vec2 u_pointer;
uniform float u_time;
uniform float u_deltaTime;
uniform float u_rms;
uniform float u_centroid;
uniform float u_freeze;
uniform float u_intensity;
uniform float u_visualMode;
uniform float u_audioDensity;
uniform float u_audioGrainMs;
uniform float u_audioSprayMs;
uniform float u_audioPitchJitter;
uniform float u_clickImpulse;
uniform float u_freezeSourceAge;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float modeMultiplier() {
  if (u_visualMode < 0.5) {
    return 1.24;
  }
  if (u_visualMode < 1.5) {
    return 0.88;
  }
  return 0.58;
}

void main() {
  vec2 cell = floor(v_uv * u_stateResolution);
  vec4 previous = texture(u_previousState, (cell + 0.5) / u_stateResolution);
  float wasActive = step(0.002, previous.a) * step(previous.r, 0.995);
  float grainMs = u_visualMode < 1.5 ? u_audioGrainMs : u_audioGrainMs * 1.42;
  float baseDurationSeconds = max(0.028, grainMs / 1000.0);
  float previousDurationSeconds = max(0.025, mix(0.025, 0.305, previous.g));
  float freezeLock = smoothstep(0.48, 0.86, u_freeze);
  float nextAge = previous.r + u_deltaTime / previousDurationSeconds;
  float expired = 1.0 - step(nextAge, 0.995);
  float active = wasActive * (1.0 - expired);

  vec2 seedPoint = cell + vec2(u_time * 0.00037, u_time * 0.00091);
  float triggerNoise = hash12(seedPoint + vec2(13.1, 9.7));
  float seed = hash12(seedPoint + vec2(31.7, 4.3));
  float sprayNorm = clamp(u_audioSprayMs / 140.0, 0.0, 1.0);
  float densityNorm = clamp((u_audioDensity - 4.0) / 32.0, 0.0, 1.0);
  float targetActiveFraction = mix(0.1, 0.46, densityNorm) * modeMultiplier();
  targetActiveFraction *= 0.78 + u_intensity * 0.34 + u_rms * 0.22 + u_clickImpulse * 0.28 + freezeLock * 0.12;
  float spawnProbability = clamp(targetActiveFraction * u_deltaTime / baseDurationSeconds, 0.0, 0.72);
  float canRespawn = 1.0 - active;
  float shouldSpawn = canRespawn * step(triggerNoise, spawnProbability);

  float durationJitter = mix(0.72, 1.58, hash12(seedPoint + vec2(4.0, 19.0)));
  float durationNorm = clamp((baseDurationSeconds * durationJitter - 0.025) / 0.28, 0.0, 1.0);
  float sourceAge = clamp(
    mix(0.0, 0.98, hash12(seedPoint + vec2(22.0, 5.0))) * (0.45 + sprayNorm * 0.72)
      + u_centroid * 0.18,
    0.0,
    1.0
  );
  float freezeSpray = (seed - 0.5) * (0.035 + sprayNorm * 0.08);
  float frozenSourceAge = clamp(u_freezeSourceAge + freezeSpray, 0.0, 1.0);
  sourceAge = mix(sourceAge, frozenSourceAge, freezeLock);
  float stableSeed = max(0.01, seed);

  vec4 next = vec4(
    clamp(nextAge, 0.0, 1.0),
    previous.g,
    mix(previous.b, frozenSourceAge, freezeLock),
    previous.a
  );
  vec4 spawned = vec4(0.0, durationNorm, sourceAge, stableSeed);

  next = mix(next, vec4(0.0), expired);
  next = mix(next, spawned, shouldSpawn);
  outColor = next;
}
