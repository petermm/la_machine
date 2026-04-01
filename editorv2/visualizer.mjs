import {
  SERVO_BUTTON_CONTACT_PERCENT,
  SERVO_DOOR_PERCENT
} from "./parser.mjs";
import {
  estimateFastServoMoveDurationMs,
  estimateTargetDutyTimeoutMs,
  targetPercentToDuty
} from "./servo_runtime.mjs";

function lerp(from, to, ratio) {
  return from + (to - from) * ratio;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function renderTimelineDuration(durationMs) {
  return Math.max(1, durationMs || 0);
}

function interpolatePercent(from, to, ratio) {
  return lerp(from, to, clamp01(ratio));
}

function servoEventPercentAtTime(event, timeMs) {
  if (timeMs <= event.anchorMs) {
    return event.startPercent;
  }

  if (timeMs >= event.motionEndMs) {
    return event.targetPercent;
  }

  const ratio =
    event.motionDurationMs <= 0 ? 1 : (timeMs - event.anchorMs) / event.motionDurationMs;
  return interpolatePercent(event.startPercent, event.targetPercent, ratio);
}

function servoStartPercentAtTime(event, timeMs) {
  if (!event) {
    return 0;
  }

  if (timeMs >= event.endMs) {
    return event.targetPercent;
  }

  if (timeMs <= event.anchorMs) {
    return event.startPercent;
  }

  return servoEventPercentAtTime(event, timeMs);
}

function visibleServoEventSnapshot(event, nextEvent = null) {
  const nextAnchorMs = nextEvent?.anchorMs;
  const endMs =
    Number.isFinite(nextAnchorMs) && nextAnchorMs < event.motionEndMs
      ? nextAnchorMs
      : event.motionEndMs;

  return {
    endMs,
    endPercent: servoEventPercentAtTime(event, endMs),
    durationMs: Math.max(0, endMs - event.anchorMs),
    interrupted: endMs < event.motionEndMs
  };
}

export function estimateServoMinDuration(fromPercent, toPercent) {
  return estimateFastServoMoveDurationMs(fromPercent, toPercent);
}

function createRuntimeServoState(initialPercent = 0) {
  const initialDuty = targetPercentToDuty(initialPercent);
  return {
    settledPercent: initialPercent,
    preMinDuty: initialDuty,
    preMaxDuty: initialDuty,
    activeEvent: null
  };
}

function settleRuntimeServoState(state, timeMs) {
  if (!state.activeEvent || timeMs < state.activeEvent.endMs) {
    return;
  }

  state.settledPercent = state.activeEvent.targetPercent;
  state.preMinDuty = state.activeEvent.targetDuty;
  state.preMaxDuty = state.activeEvent.targetDuty;
  state.activeEvent = null;
}

function currentRuntimeServoPercent(state, timeMs) {
  if (!state.activeEvent) {
    return state.settledPercent;
  }
  return servoStartPercentAtTime(state.activeEvent, timeMs);
}

function resolveAudioDuration(element, soundDurations, fallbackAudioDurationMs) {
  const cached = soundDurations.get(element.path);
  if (Number.isFinite(cached) && cached > 0) {
    return {
      durationMs: cached,
      resolved: true,
      usedFallback: false
    };
  }

  return {
    durationMs: fallbackAudioDurationMs,
    resolved: false,
    usedFallback: true
  };
}

function buildServoSegments(servoEvents, totalDurationMs) {
  const segments = [];
  let activeMove = null;
  let currentTime = 0;
  let currentPercent = 0;

  for (const event of servoEvents) {
    if (activeMove) {
      const activeSnapshot = visibleServoEventSnapshot(activeMove, event);
      segments.push({
        kind: "move",
        fromTimeMs: activeMove.anchorMs,
        fromPercent: activeMove.startPercent,
        toTimeMs: activeSnapshot.endMs,
        toPercent: activeSnapshot.endPercent
      });
      currentTime = activeSnapshot.endMs;
      currentPercent = activeSnapshot.endPercent;
    }

    if (event.anchorMs > currentTime) {
      segments.push({
        kind: "hold",
        fromTimeMs: currentTime,
        fromPercent: currentPercent,
        toTimeMs: event.anchorMs,
        toPercent: currentPercent
      });
      currentTime = event.anchorMs;
    }

    activeMove = event;
  }

  if (activeMove) {
    const activeSnapshot = visibleServoEventSnapshot(activeMove);
    segments.push({
      kind: "move",
      fromTimeMs: activeMove.anchorMs,
      fromPercent: activeMove.startPercent,
      toTimeMs: activeSnapshot.endMs,
      toPercent: activeSnapshot.endPercent
    });
    currentTime = activeSnapshot.endMs;
    currentPercent = activeSnapshot.endPercent;
  }

  if (totalDurationMs > currentTime) {
    segments.push({
      kind: "hold",
      fromTimeMs: currentTime,
      fromPercent: currentPercent,
      toTimeMs: totalDurationMs,
      toPercent: currentPercent
    });
  }

  return segments;
}

export function computeTimeline(elements, options = {}) {
  const { soundDurations = new Map(), fallbackAudioDurationMs = 1000 } = options;
  const warnings = [];
  const audioEvents = [];
  const servoEvents = [];

  let cursorMs = 0;
  let lastAudioEvent = null;
  const servoState = createRuntimeServoState();

  for (const element of elements) {
    settleRuntimeServoState(servoState, cursorMs);

    if (element.type === "wait") {
      if (element.mode === "sound") {
        if (lastAudioEvent) {
          cursorMs = Math.max(cursorMs, lastAudioEvent.anchorMs + lastAudioEvent.durationMs);
        } else {
          warnings.push({
            level: "warning",
            message: "Encountered {wait, sound} before any audio block. It has no effect."
          });
        }
      } else if (element.mode === "servo") {
        if (servoState.activeEvent) {
          cursorMs = Math.max(cursorMs, servoState.activeEvent.endMs);
        } else {
          if (!servoEvents.length) {
            warnings.push({
              level: "warning",
              message: "Encountered {wait, servo} before any servo block. It has no effect."
            });
          }
        }
      } else {
        cursorMs += Math.max(0, element.durationMs ?? 0);
      }
      settleRuntimeServoState(servoState, cursorMs);
      continue;
    }

    if (element.type === "mp3") {
      const resolvedDuration = resolveAudioDuration(
        element,
        soundDurations,
        fallbackAudioDurationMs
      );
      const event = {
        ...element,
        anchorMs: cursorMs,
        durationMs: resolvedDuration.durationMs,
        resolvedDuration: resolvedDuration.resolved,
        usedFallback: resolvedDuration.usedFallback
      };
      audioEvents.push(event);
      lastAudioEvent = event;

      if (resolvedDuration.usedFallback) {
        warnings.push({
          level: "info",
          message: `Using ${resolvedDuration.durationMs} ms as a fallback duration for "${element.path}" until metadata loads.`
        });
      }
      continue;
    }

    if (element.type === "servo") {
      const targetDuty = targetPercentToDuty(element.targetPercent);
      const requestedDurationMs = Math.max(0, element.durationMs ?? 0);
      const hasExplicitDuration = Number.isFinite(element.durationMs) && element.durationMs > 0;

      let anchorMs = cursorMs;
      let startPercent;
      let minDurationMs;
      let actualDurationMs;
      let motionDurationMs;

      if (hasExplicitDuration) {
        if (servoState.activeEvent) {
          anchorMs = Math.max(anchorMs, servoState.activeEvent.endMs);
          settleRuntimeServoState(servoState, anchorMs);
          cursorMs = anchorMs;
        }

        startPercent = servoState.settledPercent;
        const startDuty = targetPercentToDuty(startPercent);
        minDurationMs = estimateTargetDutyTimeoutMs(targetDuty, startDuty, startDuty);
        actualDurationMs = Math.max(requestedDurationMs, minDurationMs);
        motionDurationMs = actualDurationMs;
        servoState.preMinDuty = Math.min(startDuty, targetDuty);
        servoState.preMaxDuty = Math.max(startDuty, targetDuty);
      } else {
        startPercent = currentRuntimeServoPercent(servoState, anchorMs);
        minDurationMs = estimateTargetDutyTimeoutMs(
          targetDuty,
          servoState.preMinDuty,
          servoState.preMaxDuty
        );
        actualDurationMs = minDurationMs;
        motionDurationMs = Math.min(
          actualDurationMs,
          estimateFastServoMoveDurationMs(startPercent, element.targetPercent)
        );
        servoState.preMinDuty = Math.min(servoState.preMinDuty, targetDuty);
        servoState.preMaxDuty = Math.max(servoState.preMaxDuty, targetDuty);
      }

      const event = {
        ...element,
        anchorMs,
        startPercent,
        targetDuty,
        requestedDurationMs,
        minDurationMs,
        actualDurationMs,
        motionDurationMs,
        motionEndMs: anchorMs + motionDurationMs,
        endMs: anchorMs + actualDurationMs
      };
      servoEvents.push(event);
      servoState.activeEvent = event;
    }
  }

  const lastAudioEnd = audioEvents.reduce(
    (max, event) => Math.max(max, event.anchorMs + event.durationMs),
    0
  );
  const lastVisibleServoEnd = servoEvents.reduce(
    (max, event) => Math.max(max, event.motionEndMs),
    0
  );
  const lastServoSettleEnd = servoEvents.reduce((max, event) => Math.max(max, event.endMs), 0);
  const durationMs = Math.max(0, cursorMs, lastAudioEnd, lastVisibleServoEnd);

  return {
    audioEvents,
    servoEvents,
    servoSegments: buildServoSegments(servoEvents, durationMs),
    durationMs,
    runtimeDurationMs: Math.max(0, cursorMs, lastAudioEnd, lastServoSettleEnd),
    warnings
  };
}

function getServoPercentAtTime(timeline, timeMs) {
  if (!timeline.servoSegments.length) {
    return 0;
  }

  const clampedTime = clamp(timeMs, 0, timeline.durationMs);
  for (const segment of timeline.servoSegments) {
    if (clampedTime < segment.fromTimeMs) {
      continue;
    }
    if (clampedTime <= segment.toTimeMs) {
      const span = segment.toTimeMs - segment.fromTimeMs;
      if (segment.kind === "hold" || span <= 0) {
        return segment.toPercent;
      }
      return interpolatePercent(
        segment.fromPercent,
        segment.toPercent,
        (clampedTime - segment.fromTimeMs) / span
      );
    }
  }

  return timeline.servoSegments.at(-1)?.toPercent ?? 0;
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, ratio };
}

function getTimelineLayout(canvas, durationMs) {
  const cssWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const cssHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
  const margin = { top: 30, right: 28, bottom: 42, left: 58 };
  const innerWidth = cssWidth - margin.left - margin.right;
  const innerHeight = cssHeight - margin.top - margin.bottom;
  const gap = 24;
  const laneHeight = (innerHeight - gap) / 2;
  const audioLane = { x: margin.left, y: margin.top, width: innerWidth, height: laneHeight };
  const servoLane = {
    x: margin.left,
    y: margin.top + laneHeight + gap,
    width: innerWidth,
    height: laneHeight
  };

  return {
    cssWidth,
    cssHeight,
    margin,
    innerWidth,
    innerHeight,
    gap,
    laneHeight,
    audioLane,
    servoLane,
    durationMs
  };
}

export function timelineTimeFromClientX(canvas, timeline, clientX) {
  if (!canvas) {
    return 0;
  }

  const durationMs = renderTimelineDuration(timeline?.durationMs);
  const layout = getTimelineLayout(canvas, durationMs);
  const rect = canvas.getBoundingClientRect();
  const localX = clientX - rect.left;
  const clampedX = clamp(localX, layout.audioLane.x, layout.audioLane.x + layout.audioLane.width);
  const ratio =
    layout.audioLane.width <= 0 ? 0 : (clampedX - layout.audioLane.x) / layout.audioLane.width;

  return ratio * durationMs;
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlaybackBadge(ctx, x, y, label, minX, maxX) {
  ctx.save();
  ctx.font = MACHINE_BADGE_FONT;
  const paddingX = 10;
  const badgeHeight = 26;
  const textWidth = ctx.measureText(label).width;
  const badgeWidth = textWidth + paddingX * 2;
  const clampedX = Math.max(minX, Math.min(x - badgeWidth / 2, maxX - badgeWidth));

  ctx.fillStyle = "rgba(255, 120, 97, 0.96)";
  roundRect(ctx, clampedX, y, badgeWidth, badgeHeight, 13);
  ctx.fill();

  const pointerX = Math.max(clampedX + 10, Math.min(x, clampedX + badgeWidth - 10));
  ctx.beginPath();
  ctx.moveTo(pointerX - 6, y + badgeHeight);
  ctx.lineTo(pointerX + 6, y + badgeHeight);
  ctx.lineTo(pointerX, y + badgeHeight + 8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255, 248, 242, 0.96)";
  ctx.textBaseline = "middle";
  ctx.fillText(label, clampedX + paddingX, y + badgeHeight / 2);
  ctx.restore();
}

function measureLabelBounds(ctx, text, x, y, align = "left") {
  const metrics = ctx.measureText(text);
  const width = metrics.width;
  const ascent = metrics.actualBoundingBoxAscent || 8;
  const descent = metrics.actualBoundingBoxDescent || 4;
  let left = x;

  if (align === "center") {
    left -= width / 2;
  } else if (align === "right") {
    left -= width;
  }

  return {
    left,
    right: left + width,
    top: y - ascent,
    bottom: y + descent,
    width
  };
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.right + padding <= b.left ||
    a.left >= b.right + padding ||
    a.bottom + padding <= b.top ||
    a.top >= b.bottom + padding
  );
}

function drawCollisionAwareLabel(ctx, text, anchorX, anchorY, positions, bounds, occupiedLabels) {
  const maxWidth = Math.max(0, bounds.maxX - bounds.minX);
  if (maxWidth <= 0) {
    return false;
  }

  for (const position of positions) {
    let candidate = measureLabelBounds(
      ctx,
      text,
      anchorX + position.dx,
      anchorY + position.dy,
      position.align
    );

    const overflowLeft = bounds.minX - candidate.left;
    const overflowRight = candidate.right - bounds.maxX;
    if (overflowLeft > 0) {
      candidate.left += overflowLeft;
      candidate.right += overflowLeft;
    } else if (overflowRight > 0) {
      candidate.left -= overflowRight;
      candidate.right -= overflowRight;
    }

    if (
      candidate.left < bounds.minX ||
      candidate.right > bounds.maxX ||
      candidate.top < bounds.minY ||
      candidate.bottom > bounds.maxY
    ) {
      continue;
    }

    if (occupiedLabels.some((occupied) => rectsOverlap(candidate, occupied, 6))) {
      continue;
    }

    ctx.fillText(text, candidate.left, anchorY + position.dy);
    occupiedLabels.push(candidate);
    return true;
  }

  return false;
}

function drawQuad(ctx, a, b, c, d) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}

function pointLerp(a, b, ratio) {
  return {
    x: lerp(a.x, b.x, ratio),
    y: lerp(a.y, b.y, ratio)
  };
}

function pointOnPlane(origin, xAxis, yAxis, u, v) {
  return {
    x: origin.x + xAxis.x * u + yAxis.x * v,
    y: origin.y + xAxis.y * u + yAxis.y * v
  };
}

function rotatePoint(point, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  };
}

const FONT_SANS = '"IBM Plex Sans", "Avenir Next", sans-serif';
const FONT_MONO = '"IBM Plex Mono", "SFMono-Regular", monospace';
const MACHINE_TITLE_FONT = `600 13px ${FONT_SANS}`;
const MACHINE_TEXT_FONT = `12px ${FONT_MONO}`;
const MACHINE_BADGE_FONT = `600 12px ${FONT_MONO}`;
const TIMELINE_TITLE_FONT = `600 13px ${FONT_SANS}`;
const TIMELINE_TEXT_FONT = `12px ${FONT_MONO}`;
const TIMELINE_REFERENCE_LINES = [
  { percent: SERVO_DOOR_PERCENT, color: "rgba(239, 138, 115, 0.8)", label: "door" },
  {
    percent: SERVO_BUTTON_CONTACT_PERCENT,
    color: "rgba(240, 204, 106, 0.82)",
    label: "contact"
  }
];

function beginCanvasFrame(canvas) {
  const { width, height, ratio } = resizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(ratio, ratio);
  return {
    ctx,
    cssWidth: width / ratio,
    cssHeight: height / ratio
  };
}

function describeMachineState({ contactRatio, reachRatio, doorPushRatio }) {
  if (contactRatio > 0.02) {
    return "pressing switch";
  }

  if (reachRatio > 0.02) {
    return "reaching across top";
  }

  if (doorPushRatio > 0.02) {
    return "pushing lid open";
  }

  return "idle";
}

function createMachineScene(cssWidth, cssHeight) {
  const frame = { x: 28, y: 20, width: cssWidth - 56, height: cssHeight - 40 };
  const cubeSize = Math.min(148, Math.max(108, cssWidth * 0.165));
  const topOffset = { x: cubeSize * 0.28, y: -cubeSize * 0.14 };
  const baseY = cssHeight * 0.79;
  const frontLeftX = cssWidth * 0.5 - cubeSize * 0.52;

  const frontTopLeft = { x: frontLeftX, y: baseY - cubeSize };
  const frontTopRight = { x: frontLeftX + cubeSize, y: baseY - cubeSize };
  const frontBottomRight = { x: frontLeftX + cubeSize, y: baseY };
  const frontBottomLeft = { x: frontLeftX, y: baseY };
  const backTopLeft = {
    x: frontTopLeft.x + topOffset.x,
    y: frontTopLeft.y + topOffset.y
  };
  const backTopRight = {
    x: frontTopRight.x + topOffset.x,
    y: frontTopRight.y + topOffset.y
  };
  const backBottomRight = {
    x: frontBottomRight.x + topOffset.x,
    y: frontBottomRight.y + topOffset.y
  };

  return {
    cssWidth,
    cssHeight,
    frame,
    cubeSize,
    frontLeftX,
    baseY,
    frontTopLeft,
    frontTopRight,
    frontBottomRight,
    frontBottomLeft,
    backTopLeft,
    backTopRight,
    backBottomRight
  };
}

function createLidGeometry(scene) {
  const lidFront = pointLerp(scene.frontTopLeft, scene.frontTopRight, 0.5);
  const lidBack = pointLerp(scene.backTopLeft, scene.backTopRight, 0.5);
  const lidXAxis = {
    x: lidFront.x - scene.frontTopLeft.x,
    y: lidFront.y - scene.frontTopLeft.y
  };
  const lidYAxis = {
    x: scene.backTopLeft.x - scene.frontTopLeft.x,
    y: scene.backTopLeft.y - scene.frontTopLeft.y
  };

  return {
    lidFront,
    lidBack,
    lidXAxis,
    lidYAxis,
    fixedOrigin: lidFront,
    fixedXAxis: {
      x: scene.frontTopRight.x - lidFront.x,
      y: scene.frontTopRight.y - lidFront.y
    },
    fixedYAxis: {
      x: lidBack.x - lidFront.x,
      y: lidBack.y - lidFront.y
    }
  };
}

function createButtonGeometry({ fixedOrigin, fixedXAxis, fixedYAxis, cubeSize, contactRatio }) {
  const ballBase = pointOnPlane(fixedOrigin, fixedXAxis, fixedYAxis, 0.5, 0.46);
  const buttonPress = contactRatio * 8;
  const stemTop = { x: ballBase.x, y: ballBase.y - cubeSize * 0.08 + buttonPress };
  const ballRadius = cubeSize * 0.085;

  return {
    ballBase,
    stemTop,
    ballRadius
  };
}

function createOpenLidGeometry({ lidFront, lidBack, cubeSize, doorPushRatio }) {
  const lidOpenFront = {
    x: lidFront.x - cubeSize * 0.08 * doorPushRatio,
    y: lidFront.y - cubeSize * 0.4 * doorPushRatio
  };
  const lidOpenBack = {
    x: lidBack.x + cubeSize * 0.02 * doorPushRatio,
    y: lidBack.y - cubeSize * 0.54 * doorPushRatio
  };
  const lidPushAnchor = pointLerp(lidOpenFront, lidOpenBack, 0.42);

  return {
    lidOpenFront,
    lidOpenBack,
    lidPushTarget: {
      x: lidPushAnchor.x - cubeSize * 0.034,
      y: lidPushAnchor.y + cubeSize * 0.13
    }
  };
}

function createArmGeometry({
  frontTopLeft,
  lidXAxis,
  lidYAxis,
  cubeSize,
  ballRadius,
  stemTop,
  lidPushTarget,
  servoPercent,
  doorPushRatio
}) {
  const buttonContactTarget = {
    x: stemTop.x - ballRadius * 1.02,
    y: stemTop.y + ballRadius * 0.06
  };
  const armPivot = pointOnPlane(frontTopLeft, lidXAxis, lidYAxis, 0.68, 0.58);
  armPivot.x -= cubeSize * 0.014;
  armPivot.y += cubeSize * 0.18;

  const tuckedTarget = {
    x: armPivot.x - cubeSize * 0.08,
    y: armPivot.y - cubeSize * 0.2
  };
  const tipRadius = Math.max(
    cubeSize * 0.36,
    Math.hypot(buttonContactTarget.x - armPivot.x, buttonContactTarget.y - armPivot.y) * 0.96
  );
  const legLength = tipRadius * 0.62;
  const tipDrop = legLength * 0.05;
  const archSpan = Math.sqrt(
    Math.max(1, tipRadius * tipRadius - Math.pow(legLength - tipDrop, 2))
  );
  const archHeight = cubeSize * 0.042;
  const motionArmProfile = {
    corner: { x: 0, y: -legLength },
    c1: { x: archSpan * 0.28, y: -legLength - archHeight },
    c2: { x: archSpan * 0.96, y: -legLength - archHeight * 0.14 },
    tip: { x: archSpan, y: -legLength + tipDrop }
  };
  const visibleArmLengthScale = 1.16;
  const scaleFromCorner = (point) => ({
    x:
      motionArmProfile.corner.x +
      (point.x - motionArmProfile.corner.x) * visibleArmLengthScale,
    y:
      motionArmProfile.corner.y +
      (point.y - motionArmProfile.corner.y) * visibleArmLengthScale
  });
  const armProfile = {
    corner: motionArmProfile.corner,
    c1: scaleFromCorner(motionArmProfile.c1),
    c2: scaleFromCorner(motionArmProfile.c2),
    tip: scaleFromCorner(motionArmProfile.tip)
  };
  const angleForLocalPoint = (point) => Math.atan2(point.y, point.x);
  const tipForAngle = (angle, localPoint = motionArmProfile.tip) => {
    const tip = rotatePoint(localPoint, angle);
    return {
      x: armPivot.x + tip.x,
      y: armPivot.y + tip.y
    };
  };
  const findAngleForTarget = (target, minAngle, maxAngle, localPoint = motionArmProfile.tip) => {
    let bestAngle = minAngle;
    let bestScore = Number.POSITIVE_INFINITY;
    const steps = 72;
    for (let index = 0; index <= steps; index += 1) {
      const angle = lerp(minAngle, maxAngle, index / steps);
      const tip = tipForAngle(angle, localPoint);
      const dx = tip.x - target.x;
      const dy = tip.y - target.y;
      const score = dx * dx + dy * dy;
      if (score < bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
    return bestAngle;
  };
  const angleForTarget = (target, localPoint = motionArmProfile.tip) =>
    Math.atan2(target.y - armPivot.y, target.x - armPivot.x) - angleForLocalPoint(localPoint);
  const tuckedAngle = findAngleForTarget(tuckedTarget, -Math.PI * 0.95, -Math.PI * 0.2);
  const pushAngle = angleForTarget(lidPushTarget);
  const reachAngle = angleForTarget(buttonContactTarget, armProfile.tip);
  const sweepRatio = clamp01(
    (servoPercent - SERVO_DOOR_PERCENT) /
      Math.max(1, SERVO_BUTTON_CONTACT_PERCENT - SERVO_DOOR_PERCENT)
  );
  const easedSweepRatio = Math.pow(sweepRatio, 1.9);
  const armAngle =
    sweepRatio > 0.001
      ? lerp(pushAngle, reachAngle, easedSweepRatio)
      : lerp(tuckedAngle, pushAngle, doorPushRatio);
  const transformArmPoint = (point) => {
    const rotated = rotatePoint(point, armAngle);
    return {
      x: armPivot.x + rotated.x,
      y: armPivot.y + rotated.y
    };
  };
  const armRevealRatio = clamp01(doorPushRatio);
  const armCorner = transformArmPoint(armProfile.corner);
  const revealArmPoint = (point) => pointLerp(armCorner, transformArmPoint(point), armRevealRatio);

  return {
    showArm: armRevealRatio > 0.001,
    armRevealRatio,
    armCorner,
    armControl1: revealArmPoint(armProfile.c1),
    armControl2: revealArmPoint(armProfile.c2),
    armTip: revealArmPoint(armProfile.tip)
  };
}

function createMachineViewModel(cssWidth, cssHeight, timeline, playbackTimeMs, activeAudioEventIds) {
  const currentTimeMs = clamp(playbackTimeMs, 0, timeline.durationMs || 0);
  const servoPercent = getServoPercentAtTime(timeline, currentTimeMs);
  const doorPushRatio = clamp01(servoPercent / Math.max(1, SERVO_DOOR_PERCENT));
  const reachRatio = clamp01(
    (servoPercent - SERVO_DOOR_PERCENT) / Math.max(1, 100 - SERVO_DOOR_PERCENT)
  );
  const contactRatio = clamp01(
    (servoPercent - SERVO_BUTTON_CONTACT_PERCENT) /
      Math.max(1, 100 - SERVO_BUTTON_CONTACT_PERCENT)
  );
  const audioActive = activeAudioEventIds.size > 0;
  const scene = createMachineScene(cssWidth, cssHeight);
  const lid = createLidGeometry(scene);
  const button = createButtonGeometry({
    fixedOrigin: lid.fixedOrigin,
    fixedXAxis: lid.fixedXAxis,
    fixedYAxis: lid.fixedYAxis,
    cubeSize: scene.cubeSize,
    contactRatio
  });
  const openLid = createOpenLidGeometry({
    lidFront: lid.lidFront,
    lidBack: lid.lidBack,
    cubeSize: scene.cubeSize,
    doorPushRatio
  });
  const arm = createArmGeometry({
    frontTopLeft: scene.frontTopLeft,
    lidXAxis: lid.lidXAxis,
    lidYAxis: lid.lidYAxis,
    cubeSize: scene.cubeSize,
    ballRadius: button.ballRadius,
    stemTop: button.stemTop,
    lidPushTarget: openLid.lidPushTarget,
    servoPercent,
    doorPushRatio
  });

  return {
    ...scene,
    ...lid,
    ...button,
    ...openLid,
    ...arm,
    currentTimeMs,
    servoPercent,
    doorPushRatio,
    reachRatio,
    contactRatio,
    audioActive,
    stateText: describeMachineState({ contactRatio, reachRatio, doorPushRatio })
  };
}

function drawMachineBackdrop(ctx, model) {
  ctx.fillStyle = "#4b74c9";
  ctx.fillRect(0, 0, model.cssWidth, model.cssHeight);

  ctx.fillStyle = "#ff8d11";
  ctx.beginPath();
  ctx.moveTo(0, model.cssHeight * 0.14);
  ctx.lineTo(model.cssWidth * 0.34, model.cssHeight * 0.56);
  ctx.lineTo(0, model.cssHeight * 0.8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#efe2d8";
  ctx.beginPath();
  ctx.moveTo(0, model.cssHeight * 0.72);
  ctx.lineTo(model.cssWidth * 0.38, model.cssHeight * 0.56);
  ctx.lineTo(model.cssWidth, model.cssHeight * 0.78);
  ctx.lineTo(model.cssWidth, model.cssHeight);
  ctx.lineTo(0, model.cssHeight);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 248, 236, 0.18)";
  ctx.lineWidth = 1;
  roundRect(ctx, model.frame.x, model.frame.y, model.frame.width, model.frame.height, 18);
  ctx.stroke();
}

function drawMachineBody(ctx, model) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.beginPath();
  ctx.ellipse(
    model.frontLeftX + model.cubeSize * 0.72,
    model.baseY + 10,
    model.cubeSize * 0.72,
    18,
    -0.08,
    0,
    Math.PI * 2
  );
  ctx.fill();

  const rightFaceGradient = ctx.createLinearGradient(
    model.frontTopRight.x,
    model.frontTopRight.y,
    model.backBottomRight.x,
    model.backBottomRight.y
  );
  rightFaceGradient.addColorStop(0, "#e89f09");
  rightFaceGradient.addColorStop(1, "#cb7f05");
  ctx.fillStyle = rightFaceGradient;
  drawQuad(
    ctx,
    model.frontTopRight,
    model.backTopRight,
    model.backBottomRight,
    model.frontBottomRight
  );
  ctx.fill();

  const frontFaceGradient = ctx.createLinearGradient(
    model.frontTopLeft.x,
    model.frontTopLeft.y,
    model.frontTopRight.x,
    model.frontBottomRight.y
  );
  frontFaceGradient.addColorStop(0, "#ffd51c");
  frontFaceGradient.addColorStop(0.7, "#f6bd12");
  frontFaceGradient.addColorStop(1, "#e8a10b");
  ctx.fillStyle = frontFaceGradient;
  drawQuad(
    ctx,
    model.frontTopLeft,
    model.frontTopRight,
    model.frontBottomRight,
    model.frontBottomLeft
  );
  ctx.fill();

  ctx.strokeStyle = "rgba(35, 28, 23, 0.22)";
  ctx.lineWidth = 1.2;
  drawQuad(
    ctx,
    model.frontTopLeft,
    model.frontTopRight,
    model.frontBottomRight,
    model.frontBottomLeft
  );
  ctx.stroke();
  drawQuad(
    ctx,
    model.frontTopRight,
    model.backTopRight,
    model.backBottomRight,
    model.frontBottomRight
  );
  ctx.stroke();

  ctx.strokeStyle = "#171411";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(model.frontBottomLeft.x + 4, model.frontBottomLeft.y);
  ctx.lineTo(model.frontBottomRight.x - 4, model.frontBottomRight.y);
  ctx.lineTo(model.backBottomRight.x - 3, model.backBottomRight.y);
  ctx.stroke();
}

function drawMachineDeck(ctx, model) {
  ctx.fillStyle = "#171411";
  drawQuad(ctx, model.lidFront, model.frontTopRight, model.backTopRight, model.lidBack);
  ctx.fill();

  ctx.fillStyle = "#13100d";
  drawQuad(ctx, model.frontTopLeft, model.lidFront, model.lidBack, model.backTopLeft);
  ctx.fill();

  ctx.fillStyle = model.audioActive
    ? "rgba(104, 228, 228, 0.9)"
    : "rgba(255, 255, 255, 0.18)";
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const hole = pointOnPlane(
        model.frontTopLeft,
        model.lidXAxis,
        model.lidYAxis,
        0.18 + col * 0.14,
        0.24 + row * 0.14
      );
      ctx.beginPath();
      ctx.arc(hole.x, hole.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(model.lidFront.x, model.lidFront.y);
  ctx.lineTo(model.lidBack.x, model.lidBack.y);
  ctx.stroke();
}

function drawMachineButton(ctx, model) {
  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  ctx.beginPath();
  ctx.ellipse(
    model.ballBase.x + 2,
    model.ballBase.y + 4,
    model.ballRadius * 1.1,
    model.ballRadius * 0.48,
    -0.1,
    0,
    Math.PI * 2
  );
  ctx.fill();

  ctx.strokeStyle = "#201b16";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(model.ballBase.x, model.ballBase.y + 2);
  ctx.lineTo(model.stemTop.x, model.stemTop.y + model.ballRadius * 0.48);
  ctx.stroke();

  const ballGradient = ctx.createRadialGradient(
    model.stemTop.x - model.ballRadius * 0.32,
    model.stemTop.y - model.ballRadius * 0.34,
    model.ballRadius * 0.15,
    model.stemTop.x,
    model.stemTop.y,
    model.ballRadius
  );
  ballGradient.addColorStop(0, "#ffb0a3");
  ballGradient.addColorStop(0.26, "#ff6f59");
  ballGradient.addColorStop(1, "#cc1f0a");
  ctx.fillStyle = ballGradient;
  ctx.beginPath();
  ctx.arc(model.stemTop.x, model.stemTop.y, model.ballRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.38)";
  ctx.beginPath();
  ctx.arc(
    model.stemTop.x - model.ballRadius * 0.24,
    model.stemTop.y - model.ballRadius * 0.28,
    model.ballRadius * 0.24,
    0,
    Math.PI * 2
  );
  ctx.fill();
}

function drawMachineCavity(ctx, model) {
  const cavityShade = ctx.createLinearGradient(
    model.frontTopLeft.x,
    model.frontTopLeft.y,
    model.backTopLeft.x,
    model.backTopLeft.y
  );
  cavityShade.addColorStop(0, "rgba(0, 0, 0, 0.22)");
  cavityShade.addColorStop(1, "rgba(0, 0, 0, 0.04)");
  ctx.fillStyle = cavityShade;
  drawQuad(ctx, model.frontTopLeft, model.lidFront, model.lidBack, model.backTopLeft);
  ctx.fill();
}

function drawMachineArm(ctx, model) {
  if (!model.showArm) {
    return;
  }

  const revealRatio = model.armRevealRatio;
  const shadowRadiusX = model.cubeSize * 0.06 * revealRatio;
  const shadowRadiusY = model.cubeSize * 0.026 * revealRatio;
  ctx.fillStyle = `rgba(10, 9, 8, ${0.5 * revealRatio})`;
  ctx.beginPath();
  ctx.ellipse(
    model.armCorner.x - model.cubeSize * 0.018,
    model.armCorner.y + model.cubeSize * 0.012,
    shadowRadiusX,
    shadowRadiusY,
    -0.3,
    0,
    Math.PI * 2
  );
  ctx.fill();

  ctx.strokeStyle = `rgba(72, 76, 81, ${0.28 * revealRatio})`;
  ctx.lineWidth = Math.max(1.5, 12 * revealRatio);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(model.armCorner.x, model.armCorner.y + 1.5);
  ctx.bezierCurveTo(
    model.armControl1.x,
    model.armControl1.y + 2,
    model.armControl2.x,
    model.armControl2.y + 2,
    model.armTip.x,
    model.armTip.y + 1.5
  );
  ctx.stroke();

  ctx.strokeStyle = `rgba(226, 231, 236, ${revealRatio})`;
  ctx.lineWidth = Math.max(1.25, 9.5 * revealRatio);
  ctx.beginPath();
  ctx.moveTo(model.armCorner.x, model.armCorner.y);
  ctx.bezierCurveTo(
    model.armControl1.x,
    model.armControl1.y,
    model.armControl2.x,
    model.armControl2.y,
    model.armTip.x,
    model.armTip.y
  );
  ctx.stroke();

  ctx.strokeStyle = `rgba(255, 255, 255, ${0.42 * revealRatio})`;
  ctx.lineWidth = Math.max(0.8, 2.6 * revealRatio);
  ctx.beginPath();
  ctx.moveTo(model.armCorner.x - 0.5, model.armCorner.y - 1.5);
  ctx.bezierCurveTo(
    model.armControl1.x - 1,
    model.armControl1.y - 2.5,
    model.armControl2.x - 1,
    model.armControl2.y - 2.5,
    model.armTip.x - 0.5,
    model.armTip.y - 1.5
  );
  ctx.stroke();
}

function drawMachineOpenLid(ctx, model) {
  const lidGradient = ctx.createLinearGradient(
    model.frontTopLeft.x,
    model.frontTopLeft.y,
    model.lidOpenBack.x,
    model.lidOpenBack.y
  );
  lidGradient.addColorStop(0, "#26211c");
  lidGradient.addColorStop(1, "#0e0c0a");
  ctx.fillStyle = lidGradient;
  drawQuad(ctx, model.frontTopLeft, model.lidOpenFront, model.lidOpenBack, model.backTopLeft);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  drawQuad(ctx, model.frontTopLeft, model.lidOpenFront, model.lidOpenBack, model.backTopLeft);
  ctx.stroke();

  ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
  for (let index = 0; index < 3; index += 1) {
    const ventA = pointOnPlane(
      model.frontTopLeft,
      model.lidXAxis,
      model.lidYAxis,
      0.16 + index * 0.12,
      0.32
    );
    const ventB = pointOnPlane(
      model.frontTopLeft,
      model.lidXAxis,
      model.lidYAxis,
      0.21 + index * 0.12,
      0.62
    );
    ctx.beginPath();
    ctx.moveTo(ventA.x, ventA.y);
    ctx.lineTo(ventB.x, ventB.y);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(10, 9, 8, 0.92)";
  drawQuad(
    ctx,
    { x: model.frontTopLeft.x + 1, y: model.frontTopLeft.y + 1 },
    { x: model.lidFront.x - 1, y: model.lidFront.y + 1 },
    { x: model.lidFront.x - 1, y: model.lidFront.y + model.cubeSize * 0.03 },
    { x: model.frontTopLeft.x + 1, y: model.frontTopLeft.y + model.cubeSize * 0.03 }
  );
  ctx.fill();
}

function drawMachineAudioActivity(ctx, model) {
  if (!model.audioActive) {
    return;
  }

  ctx.strokeStyle = "rgba(104, 228, 228, 0.34)";
  ctx.lineWidth = 2;
  for (let index = 0; index < 3; index += 1) {
    const radius = 16 + index * 10 + ((model.currentTimeMs / 80) % 10);
    ctx.beginPath();
    ctx.arc(
      model.ballBase.x - model.cubeSize * 0.18,
      model.ballBase.y - model.cubeSize * 0.06,
      radius,
      -2.8,
      -1.8
    );
    ctx.stroke();
  }
}

function drawMachineHud(ctx, model, isPlaying) {
  ctx.fillStyle = "rgba(255, 248, 236, 0.92)";
  ctx.font = MACHINE_TITLE_FONT;
  ctx.fillText("Machine View", model.frame.x + 14, model.frame.y + 22);

  ctx.font = MACHINE_TEXT_FONT;
  ctx.fillStyle = "rgba(255, 248, 236, 0.86)";
  ctx.fillText(
    `${Math.round(model.servoPercent)}% servo  |  ${model.stateText}${model.audioActive ? "  |  audio active" : ""}`,
    model.frame.x + 14,
    model.frame.y + 42
  );

  const badgeText = isPlaying ? `${(model.currentTimeMs / 1000).toFixed(2)}s` : "stopped";
  ctx.font = MACHINE_BADGE_FONT;
  const badgeWidth = ctx.measureText(badgeText).width + 20;
  const badgeX = model.frame.x + model.frame.width - badgeWidth - 14;
  const badgeY = model.frame.y + 12;
  ctx.fillStyle = isPlaying ? "rgba(255, 94, 69, 0.94)" : "rgba(255, 248, 236, 0.18)";
  roundRect(ctx, badgeX, badgeY, badgeWidth, 24, 12);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 248, 236, 0.96)";
  ctx.fillText(badgeText, badgeX + 10, badgeY + 16);
}

function createTimelineScale(layout, durationMs) {
  return {
    xAt(ms) {
      return layout.audioLane.x + (Math.max(0, ms) / durationMs) * layout.audioLane.width;
    },
    servoYAt(percent) {
      return (
        layout.servoLane.y +
        layout.servoLane.height -
        (clamp(percent, 0, 100) / 100) * layout.servoLane.height
      );
    }
  };
}

function drawTimelineBackdrop(ctx, layout) {
  const background = ctx.createLinearGradient(0, 0, layout.cssWidth, layout.cssHeight);
  background.addColorStop(0, "#110d0a");
  background.addColorStop(1, "#1c140f");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, layout.cssWidth, layout.cssHeight);

  ctx.strokeStyle = "rgba(242, 164, 71, 0.16)";
  ctx.lineWidth = 1;
  roundRect(
    ctx,
    layout.audioLane.x,
    layout.audioLane.y,
    layout.audioLane.width,
    layout.audioLane.height,
    18
  );
  ctx.stroke();
  roundRect(
    ctx,
    layout.servoLane.x,
    layout.servoLane.y,
    layout.servoLane.width,
    layout.servoLane.height,
    18
  );
  ctx.stroke();

  ctx.fillStyle = "rgba(244, 236, 223, 0.85)";
  ctx.font = TIMELINE_TITLE_FONT;
  ctx.fillText("Audio", layout.audioLane.x, layout.audioLane.y - 8);
  ctx.fillText("Servo", layout.servoLane.x, layout.servoLane.y - 8);
}

function drawTimelineGrid(ctx, layout, durationMs, scale) {
  ctx.font = TIMELINE_TEXT_FONT;
  for (let ms = 0; ms <= durationMs; ms += 250) {
    const x = scale.xAt(ms);
    const isSecond = ms % 1000 === 0;
    ctx.strokeStyle = isSecond
      ? "rgba(244, 236, 223, 0.18)"
      : "rgba(244, 236, 223, 0.08)";
    ctx.beginPath();
    ctx.moveTo(x, layout.audioLane.y);
    ctx.lineTo(x, layout.servoLane.y + layout.servoLane.height);
    ctx.stroke();

    if (isSecond) {
      ctx.fillStyle = "rgba(190, 168, 143, 0.78)";
      ctx.fillText(
        `${Math.round(ms / 1000)}s`,
        x + 4,
        layout.servoLane.y + layout.servoLane.height + 18
      );
    }
  }

  for (let percent = 25; percent < 100; percent += 25) {
    const y = scale.servoYAt(percent);
    ctx.strokeStyle = "rgba(244, 236, 223, 0.08)";
    ctx.beginPath();
    ctx.moveTo(layout.servoLane.x, y);
    ctx.lineTo(layout.servoLane.x + layout.servoLane.width, y);
    ctx.stroke();
  }
}

function drawTimelineReferenceLines(ctx, layout, scale) {
  for (const line of TIMELINE_REFERENCE_LINES) {
    const y = scale.servoYAt(line.percent);
    ctx.strokeStyle = line.color;
    ctx.beginPath();
    ctx.moveTo(layout.servoLane.x, y);
    ctx.lineTo(layout.servoLane.x + layout.servoLane.width, y);
    ctx.stroke();
    ctx.fillStyle = line.color;
    ctx.fillText(`${line.label} ${line.percent}%`, layout.servoLane.x + 8, y - 6);
  }
}

function drawWaveform(ctx, peaks, x, y, width, height, isActive) {
  if (!Array.isArray(peaks) || peaks.length === 0 || width <= 2 || height <= 2) {
    return;
  }

  const centerY = y + height / 2;
  const halfHeight = height / 2;
  const stepX = peaks.length <= 1 ? width : width / (peaks.length - 1);

  ctx.beginPath();
  ctx.moveTo(x, centerY);
  for (let index = 0; index < peaks.length; index += 1) {
    const peak = clamp01(peaks[index] ?? 0);
    ctx.lineTo(x + stepX * index, centerY - peak * halfHeight);
  }
  for (let index = peaks.length - 1; index >= 0; index -= 1) {
    const peak = clamp01(peaks[index] ?? 0);
    ctx.lineTo(x + stepX * index, centerY + peak * halfHeight);
  }
  ctx.closePath();

  ctx.fillStyle = isActive
    ? "rgba(122, 213, 154, 0.28)"
    : "rgba(250, 205, 115, 0.22)";
  ctx.fill();

  ctx.beginPath();
  for (let index = 0; index < peaks.length; index += 1) {
    const peak = clamp01(peaks[index] ?? 0);
    const pointX = x + stepX * index;
    const pointY = centerY - peak * halfHeight;
    if (index === 0) {
      ctx.moveTo(pointX, pointY);
    } else {
      ctx.lineTo(pointX, pointY);
    }
  }
  ctx.strokeStyle = isActive
    ? "rgba(194, 245, 215, 0.88)"
    : "rgba(255, 225, 170, 0.64)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawTimelineAudioEvents(
  ctx,
  layout,
  scale,
  audioEvents,
  activeAudioEventIds,
  waveformByAudioEventId
) {
  for (const event of audioEvents) {
    const x = scale.xAt(event.anchorMs);
    const w = Math.max(10, scale.xAt(event.anchorMs + event.durationMs) - x);
    const y = layout.audioLane.y + 16;
    const h = layout.audioLane.height - 32;
    const isActive = activeAudioEventIds.has(event.id);
    const peaks = waveformByAudioEventId.get(event.id);

    ctx.save();
    ctx.setLineDash(event.usedFallback ? [6, 6] : []);
    ctx.strokeStyle = event.usedFallback
      ? "rgba(240, 204, 106, 0.76)"
      : "rgba(242, 164, 71, 0.95)";
    ctx.fillStyle = event.usedFallback
      ? "rgba(240, 204, 106, 0.18)"
      : "rgba(242, 164, 71, 0.22)";
    if (isActive) {
      ctx.strokeStyle = "rgba(122, 213, 154, 0.96)";
      ctx.fillStyle = "rgba(122, 213, 154, 0.18)";
      ctx.lineWidth = 2.4;
    }
    roundRect(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.stroke();

    if (peaks) {
      ctx.save();
      roundRect(ctx, x, y, w, h, 14);
      ctx.clip();
      drawWaveform(ctx, peaks, x + 10, y + 26, Math.max(8, w - 20), Math.max(10, h - 52), isActive);
      ctx.restore();
    }
    ctx.restore();

    ctx.fillStyle = "rgba(244, 236, 223, 0.88)";
    ctx.fillText(event.path, x + 10, y + 18);
    ctx.fillStyle = "rgba(190, 168, 143, 0.78)";
    ctx.fillText(`${Math.round(event.durationMs)} ms`, x + 10, y + h - 10);
  }
}

function drawTimelineServoSegments(ctx, scale, servoSegments) {
  ctx.strokeStyle = "rgba(122, 213, 154, 0.9)";
  ctx.lineWidth = 2.2;
  for (const segment of servoSegments) {
    ctx.beginPath();
    ctx.moveTo(scale.xAt(segment.fromTimeMs), scale.servoYAt(segment.fromPercent));
    ctx.lineTo(scale.xAt(segment.toTimeMs), scale.servoYAt(segment.toPercent));
    ctx.stroke();
  }
}

function drawTimelineServoEvents(ctx, layout, scale, servoEvents) {
  const occupiedLabels = [];
  const labelBounds = {
    minX: layout.servoLane.x + 6,
    maxX: layout.servoLane.x + layout.servoLane.width - 6,
    minY: layout.servoLane.y + 10,
    maxY: layout.servoLane.y + layout.servoLane.height - 8
  };
  const percentLabelPositions = [
    { dx: 8, dy: -8, align: "left" },
    { dx: 8, dy: 14, align: "left" },
    { dx: -8, dy: -8, align: "right" },
    { dx: -8, dy: 14, align: "right" },
    { dx: 0, dy: -12, align: "center" },
    { dx: 0, dy: 18, align: "center" }
  ];
  const durationLabelPositions = [
    { dx: 0, dy: 18, align: "center" },
    { dx: 0, dy: -12, align: "center" },
    { dx: -8, dy: 18, align: "right" },
    { dx: 8, dy: 18, align: "left" },
    { dx: -8, dy: -12, align: "right" },
    { dx: 8, dy: -12, align: "left" }
  ];

  ctx.fillStyle = "rgba(255, 120, 97, 0.96)";
  for (const [index, event] of servoEvents.entries()) {
    const snapshot = visibleServoEventSnapshot(event, servoEvents[index + 1]);
    const startX = scale.xAt(event.anchorMs);
    const endX = scale.xAt(snapshot.endMs);
    const startY = scale.servoYAt(event.startPercent);
    const endY = scale.servoYAt(snapshot.endPercent);
    const isShortMove = Math.abs(endX - startX) < 14 && Math.abs(endY - startY) < 14;

    if (!isShortMove) {
      ctx.beginPath();
      ctx.arc(startX, startY, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(endX, endY, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(244, 236, 223, 0.88)";
    drawCollisionAwareLabel(
      ctx,
      `${Math.round(snapshot.endPercent)}%`,
      endX,
      endY,
      percentLabelPositions,
      labelBounds,
      occupiedLabels
    );
    ctx.fillStyle = "rgba(190, 168, 143, 0.78)";
    drawCollisionAwareLabel(
      ctx,
      `${Math.round(snapshot.durationMs)} ms`,
      (startX + endX) / 2,
      Math.max(startY, endY),
      durationLabelPositions,
      labelBounds,
      occupiedLabels
    );
    ctx.fillStyle = "rgba(255, 120, 97, 0.96)";
  }
}

function drawTimelinePlaybackCursor(ctx, timeline, layout, durationMs, scale, playbackTimeMs) {
  if (playbackTimeMs === null) {
    return;
  }

  const clampedPlaybackTime = clamp(playbackTimeMs, 0, durationMs);
  const cursorX = scale.xAt(clampedPlaybackTime);
  const cursorY = scale.servoYAt(getServoPercentAtTime(timeline, clampedPlaybackTime));

  drawPlaybackBadge(
    ctx,
    cursorX,
    layout.audioLane.y - 34,
    `${(clampedPlaybackTime / 1000).toFixed(2)}s`,
    layout.audioLane.x,
    layout.audioLane.x + layout.audioLane.width
  );

  ctx.strokeStyle = "rgba(255, 120, 97, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cursorX, layout.audioLane.y - 2);
  ctx.lineTo(cursorX, layout.servoLane.y + layout.servoLane.height + 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 120, 97, 0.24)";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(cursorX, layout.audioLane.y + 6);
  ctx.lineTo(cursorX, layout.servoLane.y + layout.servoLane.height - 6);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 120, 97, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cursorX, layout.audioLane.y - 2);
  ctx.lineTo(cursorX, layout.servoLane.y + layout.servoLane.height + 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 120, 97, 0.95)";
  ctx.beginPath();
  ctx.arc(cursorX, cursorY, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cursorX, cursorY, 12, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 120, 97, 0.28)";
  ctx.lineWidth = 3;
  ctx.stroke();
}

export function renderMachineView(canvas, timeline, options = {}) {
  if (!canvas) {
    return;
  }

  const {
    playbackTimeMs = 0,
    activeAudioEventIds = new Set(),
    isPlaying = false
  } = options;

  const { ctx, cssWidth, cssHeight } = beginCanvasFrame(canvas);
  const model = createMachineViewModel(
    cssWidth,
    cssHeight,
    timeline,
    playbackTimeMs,
    activeAudioEventIds
  );

  drawMachineBackdrop(ctx, model);
  drawMachineBody(ctx, model);
  drawMachineDeck(ctx, model);
  drawMachineButton(ctx, model);
  drawMachineCavity(ctx, model);
  drawMachineArm(ctx, model);
  drawMachineOpenLid(ctx, model);
  drawMachineAudioActivity(ctx, model);
  drawMachineHud(ctx, model, isPlaying);
}

export function renderTimeline(canvas, timeline, options = {}) {
  if (!canvas) {
    return;
  }

  const {
    playbackTimeMs = null,
    activeAudioEventIds = new Set(),
    waveformByAudioEventId = new Map()
  } = options;

  const { ctx } = beginCanvasFrame(canvas);
  const durationMs = renderTimelineDuration(timeline.durationMs);
  const layout = getTimelineLayout(canvas, durationMs);
  const scale = createTimelineScale(layout, durationMs);

  drawTimelineBackdrop(ctx, layout);
  drawTimelineGrid(ctx, layout, durationMs, scale);
  drawTimelineReferenceLines(ctx, layout, scale);
  drawTimelineAudioEvents(
    ctx,
    layout,
    scale,
    timeline.audioEvents,
    activeAudioEventIds,
    waveformByAudioEventId
  );
  drawTimelineServoSegments(ctx, scale, timeline.servoSegments);
  drawTimelineServoEvents(ctx, layout, scale, timeline.servoEvents);
  drawTimelinePlaybackCursor(ctx, timeline, layout, durationMs, scale, playbackTimeMs);
}
