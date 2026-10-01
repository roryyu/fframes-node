/**
 * Easing, spring physics and keyframe timelines.
 *
 * The expected values come from the Rust unit tests of `animation/animation.rs`,
 * `animation/cubic_bezier.rs` and `animation/spring.rs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Easing, solveEasing } from '../src/core/animation/easing.ts';
import { CubicBezierRuntime } from '../src/core/animation/cubic-bezier.ts';
import {
  SPRING_FRAME_DURATION,
  SpringRuntime,
} from '../src/core/animation/spring.ts';
import { timeline } from '../src/core/animation/timeline.ts';
import { Color } from '../src/core/color.ts';
import { Transform } from '../src/core/transform.ts';

const EPSILON = 1e-4;

function assertClose(actual: number, expected: number, epsilon: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message ?? 'value'}: expected ${expected} ± ${epsilon}, got ${actual}`,
  );
}

test('linear easing is the identity', () => {
  assert.equal(Easing.linear.solve(0), 0);
  assert.equal(Easing.linear.solve(0.25), 0.25);
  assert.equal(Easing.linear.solve(1), 1);
  assert.equal(solveEasing(Easing.linear, 0.42), 0.42);
  assert.equal(Easing.linear.kind, 'linear');
});

test('css easings start at 0, end at 1 and are symmetric at 0.5', () => {
  const presets = [Easing.easeIn, Easing.easeOut, Easing.easeInOut];
  for (const easing of presets) {
    assertClose(easing.solve(0), 0, EPSILON, `${easing.kind} solve(0)`);
    assertClose(easing.solve(1), 1, EPSILON, `${easing.kind} solve(1)`);
  }
  assertClose(Easing.easeInOut.solve(0.5), 0.5, EPSILON, 'easeInOut solve(0.5)');
});

test('easeIn starts slow and easeOut starts fast', () => {
  assert.ok(Easing.easeIn.solve(0.25) < 0.25);
  assert.ok(Easing.easeOut.solve(0.25) > 0.25);
});

test('the css presets use the documented control points', () => {
  const easeIn = CubicBezierRuntime.easeIn();
  const easeOut = CubicBezierRuntime.easeOut();
  const easeInOut = CubicBezierRuntime.easeInOut();

  assert.deepEqual([easeIn.x1, easeIn.y1, easeIn.x2, easeIn.y2], [0.42, 0, 1, 1]);
  assert.deepEqual([easeOut.x1, easeOut.y1, easeOut.x2, easeOut.y2], [0, 0, 0.58, 1]);
  assert.deepEqual([easeInOut.x1, easeInOut.y1, easeInOut.x2, easeInOut.y2], [0.42, 0, 0.58, 1]);

  assert.equal(Easing.cubicBezier(0.1, 0.2, 0.3, 0.4).x1, 0.1);
  assert.equal(Easing.cubicBezier(0.1, 0.2, 0.3, 0.4).y2, 0.4);
  assert.equal(Easing.cubicBezier(0.1, 0.2, 0.3, 0.4).kind, 'cubicBezier');
});

test('a bezier with the control points on the diagonal is the identity', () => {
  const forward = new CubicBezierRuntime(0, 0, 1, 1);
  const reverse = new CubicBezierRuntime(1, 1, 0, 0);

  for (let i = 0; i <= 100; i += 1) {
    const x = i / 100;
    assertClose(forward.solve(x), x, 1e-12, `forward solve(${x})`);
    assertClose(reverse.solve(x), x, 1e-12, `reverse solve(${x})`);
  }
});

test('out of range x control points are clamped, y control points are not', () => {
  assert.equal(new CubicBezierRuntime(-2, 0.5, 0.5, 0.5).x1, 0);
  assert.equal(new CubicBezierRuntime(2, 0.5, 0.5, 0.5).x1, 1);
  assert.equal(new CubicBezierRuntime(0.5, 0.5, -5, 0.5).x2, 0);
  assert.equal(new CubicBezierRuntime(0.5, 0.5, 5, 0.5).x2, 1);
  assert.equal(new CubicBezierRuntime(0.5, 2.5, 0.5, 3.5).y1, 2.5);
  assert.equal(new CubicBezierRuntime(0.5, 2.5, 0.5, 3.5).y2, 3.5);
});

test('bezier easing keeps the endpoints for extreme control points', () => {
  const cases = [
    [0.25, 0.1, 0.75, 0.9],
    [0.4, 0.2, 0.6, 0.8],
    [0.1, -0.3, 0.9, 1.3],
    [0.7, 0.5, 0.3, 0.5],
  ];
  for (const [x1, y1, x2, y2] of cases) {
    const easing = new CubicBezierRuntime(x1 as number, y1 as number, x2 as number, y2 as number);
    assertClose(easing.solve(0), 0, 1e-6, `solve(0) of ${[x1, y1, x2, y2]}`);
    assertClose(easing.solve(1), 1, 1e-6, `solve(1) of ${[x1, y1, x2, y2]}`);
  }
});

test('a bezier and its mirrored counterpart are inverse of each other', () => {
  const cases = [
    [0.25, 0.1, 0.75, 0.9],
    [0.4, 0.2, 0.6, 0.8],
    [0.1, 0.3, 0.9, 0.7],
    [0.7, 0.5, 0.3, 0.5],
  ];
  for (const [x1, y1, x2, y2] of cases) {
    const easing = new CubicBezierRuntime(x1 as number, y1 as number, x2 as number, y2 as number);
    const projected = new CubicBezierRuntime(y1 as number, x1 as number, y2 as number, x2 as number);
    for (let i = 0; i <= 100; i += 1) {
      const x = i / 100;
      assertClose(projected.solve(easing.solve(x)), x, 0.05, `projected solve(${x})`);
    }
  }
});

test('two bezier runtimes with the same parameters agree', () => {
  const first = new CubicBezierRuntime(0.25, 0.1, 0.75, 0.9);
  const second = new CubicBezierRuntime(0.25, 0.1, 0.75, 0.9);
  for (let i = 0; i <= 50; i += 1) {
    const x = i / 50;
    assertClose(first.solve(x), second.solve(x), 1e-12, `solve(${x})`);
  }
});

test('an under-damped spring starts at 0 and converges to 1', () => {
  const spring = new SpringRuntime(1, 100, 10);
  assert.equal(spring.solve(0), 0);
  assert.ok(spring.solve(20) > 0.999, 'a settled spring is 1');
  assertClose(spring.solve(30), 1, 1e-9, 'a long settled spring is exactly 1');
});

test('an under-damped spring overshoots before it settles', () => {
  const spring = new SpringRuntime(1, 100, 10);
  let max = 0;
  for (let t = 0; t <= 5; t += 0.005) {
    max = Math.max(max, spring.solve(t));
  }
  assert.ok(max > 1.05, `expected an overshoot above 1, got ${max}`);
  assert.ok(max < 1.4, `expected a modest overshoot, got ${max}`);
});

test('a critically damped spring never overshoots and never decreases', () => {
  const spring = new SpringRuntime(1, 100, 20);
  assertClose(spring.solve(0), 0, 1e-12, 'solve(0)');
  let previous = 0;
  for (let t = 0; t <= 5; t += 0.01) {
    const value = spring.solve(t);
    assert.ok(value >= previous - 1e-12, `critically damped spring decreased at t=${t}`);
    assert.ok(value <= 1 + 1e-12, `critically damped spring overshot at t=${t}`);
    previous = value;
  }
  assertClose(previous, 1, 1e-6, 'the critically damped spring settles');
});

test('the spring duration is measured in 60 fps frames and mirrored verbatim', () => {
  const spring = new SpringRuntime(1, 100, 10);
  const duration = spring.getDuration();

  assert.ok(Number.isFinite(duration) && duration > 0, 'a finite, positive duration');
  // The Rust source returns `elapsed * frame_duration` although `elapsed` is already in
  // seconds: ~173 frames of settling become ~4.8 instead of ~28.8 (see PORTING.md).
  assertClose(duration, 173 * SPRING_FRAME_DURATION * SPRING_FRAME_DURATION, 0.2, 'settle time');
});

test('the spring easing exposes its physics parameters', () => {
  const easing = Easing.spring({ mass: 1, stiffness: 300, damping: 26 });
  assert.equal(easing.kind, 'spring');
  assert.equal(easing.mass, 1);
  assert.equal(easing.stiffness, 300);
  assert.equal(easing.damping, 26);
  assertClose(easing.runtime.zeta, 26 / (2 * Math.sqrt(300 * 1)), 1e-12, 'zeta');
  assertClose(easing.runtime.w0, Math.sqrt(300), 1e-12, 'w0');
});

test('a timeline holds the from value before the first keyframe', () => {
  const animation = timeline<number>({
    start: 2,
    end: 4,
    from: 10,
    to: 20,
    easing: Easing.linear,
  });

  assert.equal(animation.get(0), 10);
  assert.equal(animation.get(1.5), 10);
  assert.equal(animation.get(2), 10);
  assertClose(animation.get(3), 15, 1e-9, 'halfway through the tween');
  assert.equal(animation.get(4), 20, 'past the tween the final value is returned');
  assert.equal(animation.totalDuration, 2);
});

test('a timeline interpolates with the declared easing', () => {
  const animation = timeline<number>({
    start: 0,
    end: 2,
    from: 0,
    to: 100,
    easing: Easing.easeInOut,
  });

  assertClose(animation.get(1), 50, EPSILON, 'easeInOut midpoint');
  assertClose(animation.get(0.5), 100 * Easing.easeInOut.solve(0.25), 1e-9, 'quarter');
  assert.equal(animation.totalDuration, 2);
  assert.equal(animation.finalValue, 100);
});

test('a timeline holds the previous value between keyframes', () => {
  const animation = timeline<number>(
    { start: 0, end: 1, from: 0, to: 100, easing: Easing.linear },
    { start: 3, end: 4, from: 100, to: 0, easing: Easing.linear },
  );

  assertClose(animation.get(0.999), 99.9, 1e-9, 'the tween reaches its end value');
  assert.equal(animation.get(1.5), 100, 'the gap holds the value');
  assert.equal(animation.get(2.99), 100, 'the gap holds the value until the next keyframe');
  assertClose(animation.get(3.5), 50, 1e-9, 'the second tween runs');
  assert.equal(animation.get(4), 0);
  assert.equal(animation.get(100), 0, 'past the end the final value is returned');
  assert.equal(animation.totalDuration, 4);
});

test('a tween without an end runs until the next keyframe', () => {
  const animation = timeline<number>(
    { start: 0, from: 0, to: 10, easing: Easing.linear },
    { start: 2, from: 10, to: 0, easing: Easing.linear },
  );

  assertClose(animation.get(1), 5, 1e-9, 'the first tween spans the whole gap');
  assertClose(animation.get(1.9), 9.5, 1e-9, 'the tween keeps running to the next keyframe');
  assert.equal(animation.totalDuration, 2, 'the total duration ends at the last start');
  assert.equal(animation.finalValue, 0);
  assert.equal(animation.get(2), 0, 'the skipped last keyframe leaves the final value');
});

test('keyframes are sorted by start time', () => {
  const animation = timeline<number>(
    { start: 2, end: 3, from: 20, to: 0, easing: Easing.linear },
    { start: 0, end: 1, from: 0, to: 20, easing: Easing.linear },
  );

  assertClose(animation.get(0.5), 10, 1e-9, 'the first tween by start time');
  assertClose(animation.get(2.5), 10, 1e-9, 'the second tween by start time');
  assert.equal(animation.totalDuration, 3);
});

test('a last keyframe without an end is skipped but still defines the final value', () => {
  const animation = timeline<number>(
    { start: 0, end: 1, from: 0, to: 5, easing: Easing.linear },
    { start: 1, from: 5, to: 9, easing: Easing.linear },
  );

  assert.equal(animation.finalValue, 9);
  assert.equal(animation.get(50), 9, 'there is no tween left, the final value is returned');
  assertClose(animation.get(0.999), 4.995, 1e-9, 'the only tween is the one with an explicit end');
  assert.equal(animation.get(1), 9, 'the skipped keyframe jumps straight to the final value');
});

test('an empty timeline is inert', () => {
  const animation = timeline<number>();
  assert.equal(animation.totalDuration, 0);
  assert.equal(animation.tweens.length, 0);
  assert.equal(animation.get(0), 0);
  assert.equal(animation.getLoop(3), 0);
});

test('animateLoop wraps the time around the total duration', () => {
  const animation = timeline<number>({
    start: 0,
    end: 2,
    from: 0,
    to: 100,
    easing: Easing.linear,
  });

  assertClose(animation.getLoop(0.5), animation.get(0.5), 1e-12, 'inside the duration');
  assertClose(animation.getLoop(2.5), animation.get(0.5), 1e-12, 'one period later');
  assertClose(animation.getLoop(4), animation.get(0), 1e-12, 'exactly one period later');
  assert.equal(animation.getLoop(0), 0);
});

test('a timeline interpolates colors component wise', () => {
  const animation = timeline<Color>({
    start: 0,
    end: 1,
    from: Color.fromHex('#000000'),
    to: Color.fromHex('#ffffff'),
    easing: Easing.linear,
  });

  const middle = animation.get(0.5);
  assert.equal(middle.r, 127);
  assert.equal(middle.g, 127);
  assert.equal(middle.b, 127);
  assert.equal(animation.get(0).toSvg(), '#000000');
  assert.equal(animation.get(1).toSvg(), '#ffffff');
});

test('a timeline interpolates transforms component wise', () => {
  const animation = timeline<Transform>({
    start: 0,
    end: 2,
    from: Transform.translate(0, 0),
    to: Transform.translate(0, 100),
    easing: Easing.linear,
  });

  // The Rust `Display` skips the components that are at their default (transform.rs:319-321), so
  // the animation of an identity start serializes to nothing at t=0.
  assert.equal(animation.get(0).toSvgAttribute(), '');
  assert.equal(animation.get(1).toSvgAttribute(), 'translate(0 50)');
  assert.equal(animation.get(2).toSvgAttribute(), 'translate(0 100)');
});

test('a spring keyframe without an end runs until the spring settles', () => {
  const spring = Easing.spring({ mass: 1, stiffness: 100, damping: 10 });
  const animation = timeline<number>({
    start: 0,
    from: 0,
    to: 100,
    easing: spring,
  });

  const tween = animation.tweens[0];
  assert.ok(tween !== undefined);
  assertClose(tween.end, spring.runtime.getDuration(), 1e-9, 'the tween spans the settle time');
  const settled = animation.get(animation.tweens[animation.tweens.length - 1]!.end - 0.0001);
  assert.ok(settled > 0.99, `expected the spring to be settled, got ${settled}`);
});
