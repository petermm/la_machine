export const SERVO_FULL_RANGE_TIME_MS = 1350;
export const SERVO_MAX_WIDTH_US = 2500;
export const SERVO_MIN_WIDTH_US = 500;
export const SERVO_FREQ_HZ = 50;
export const SERVO_FREQ_PERIOD_US = 1000000 / SERVO_FREQ_HZ;
export const LEDC_DUTY_RESOLUTION = 14;
export const SERVO_MAX_DUTY = 2 ** LEDC_DUTY_RESOLUTION - 1;

// Mirrors the repo default hardware revision in src/la_machine_definitions.hrl.
export const DEFAULT_SERVO_CLOSED_DUTY = 1547;
export const DEFAULT_SERVO_INTERRUPT_DUTY = 682;

export const DEFAULT_SERVO_RUNTIME_CONFIG = Object.freeze({
  closedDuty: DEFAULT_SERVO_CLOSED_DUTY,
  interruptDuty: DEFAULT_SERVO_INTERRUPT_DUTY,
  fullRangeTimeMs: SERVO_FULL_RANGE_TIME_MS,
  maxWidthUs: SERVO_MAX_WIDTH_US,
  minWidthUs: SERVO_MIN_WIDTH_US,
  maxDuty: SERVO_MAX_DUTY,
  freqPeriodUs: SERVO_FREQ_PERIOD_US
});

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function truncTowardsZero(value) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

export function targetPercentToDuty(
  targetPercent,
  config = DEFAULT_SERVO_RUNTIME_CONFIG
) {
  const boundedTarget = clampPercent(targetPercent);
  return (
    config.closedDuty +
    truncTowardsZero((boundedTarget * (config.interruptDuty - config.closedDuty)) / 100)
  );
}

export function estimateTargetDutyTimeoutMs(
  targetDuty,
  preMinDuty,
  preMaxDuty,
  config = DEFAULT_SERVO_RUNTIME_CONFIG
) {
  return Math.ceil(
    Math.max(Math.abs(targetDuty - preMinDuty), Math.abs(targetDuty - preMaxDuty)) *
      (config.fullRangeTimeMs / config.maxDuty) *
      (config.freqPeriodUs / (config.maxWidthUs - config.minWidthUs))
  );
}

export function estimateFastServoMoveDurationMs(
  fromPercent,
  toPercent,
  config = DEFAULT_SERVO_RUNTIME_CONFIG
) {
  const settledDuty = targetPercentToDuty(fromPercent, config);
  const targetDuty = targetPercentToDuty(toPercent, config);
  return estimateTargetDutyTimeoutMs(targetDuty, settledDuty, settledDuty, config);
}
