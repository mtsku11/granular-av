#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_scene;
uniform vec2 u_resolution;
uniform float u_time;

void main() {
  vec2 uv = v_uv;
  vec3 colour = texture(u_scene, uv).rgb;
  float vignette = smoothstep(1.15, 0.18, distance(uv, vec2(0.5)));
  vec3 graded = pow(max(colour, vec3(0.0)), vec3(0.92));
  graded *= vec3(1.02, 0.98, 0.93);
  graded += 0.03 * sin(vec3(uv.x, uv.y, uv.x + uv.y) * 8.0 + u_time * 0.0004);
  outColor = vec4(graded * vignette, 1.0);
}
