/**
 * Pure track-limit stewarding. Keeping the decision logic independent from
 * Phaser makes every penalty path repeatable and testable.
 */
export function createStewardState() {
  return {
    trackLimitsCount: 0,
    offTrackMs: 0,
    peakOffTrackSpeedKph: 0,
    onTrackRecoveryMs: 0,
    reviewIssued: false,
    infractionIssued: false
  };
}

function closeIncident(state) {
  return {
    ...state,
    offTrackMs: 0,
    peakOffTrackSpeedKph: 0,
    onTrackRecoveryMs: 0,
    reviewIssued: false,
    infractionIssued: false
  };
}

/**
 * Evaluates one racing frame and returns a new state plus an optional steward
 * event. Every excursion can issue only one infraction; it is closed only
 * after sustained time back on the asphalt.
 */
export function assessTrackLimits(state, { onGrass, speedKph, deltaMs }, profile) {
  const delta = Math.max(0, Number(deltaMs) || 0);
  const speed = Math.max(0, Number(speedKph) || 0);
  const next = { ...state };

  if (!onGrass) {
    next.onTrackRecoveryMs += delta;
    if (next.onTrackRecoveryMs >= profile.recoveryMs &&
        (next.offTrackMs > 0 || next.infractionIssued || next.reviewIssued)) {
      return { state: closeIncident(next), event: { type: 'clear' } };
    }
    return { state: next, event: null };
  }

  next.onTrackRecoveryMs = 0;
  next.offTrackMs += delta;
  next.peakOffTrackSpeedKph = Math.max(next.peakOffTrackSpeedKph, speed);

  if (next.infractionIssued) return { state: next, event: null };

  if (next.offTrackMs >= profile.shortcutMs &&
      next.peakOffTrackSpeedKph >= profile.shortcutSpeedKph) {
    next.infractionIssued = true;
    return { state: next, event: { type: 'shortcut-penalty', penaltyMs: profile.shortcutPenaltyMs } };
  }

  if (next.offTrackMs >= profile.breachMs) {
    next.infractionIssued = true;
    next.trackLimitsCount += 1;
    if (next.trackLimitsCount > profile.warningLimit) {
      return { state: next, event: { type: 'track-limit-penalty', penaltyMs: profile.trackLimitPenaltyMs } };
    }
    return {
      state: next,
      event: { type: next.trackLimitsCount === profile.warningLimit ? 'final-warning' : 'warning' }
    };
  }

  if (next.offTrackMs >= profile.reviewMs && !next.reviewIssued) {
    next.reviewIssued = true;
    return { state: next, event: { type: 'review' } };
  }

  return { state: next, event: null };
}
