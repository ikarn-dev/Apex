/**
 * Procedural audio.
 *
 * Every sound is synthesised in WebAudio rather than streamed from files. That
 * is a deliberate call for a web game: a decent engine loop set is several MB,
 * and on mobile data it competes directly with the car models for the download
 * budget. Two detuned saws with a lowpass follow the tacho convincingly enough
 * for an arcade racer, and cost nothing to ship.
 *
 * Autoplay policy means the context starts suspended; `resume()` must be called
 * from a real user gesture.
 */

import { clamp, lerp } from "@/lib/math";

/** Engine note range, Hz, at idle and at the limiter. */
const IDLE_HZ = 42;
const REDLINE_HZ = 290;

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;

  private engineGain: GainNode | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;

  private tyreGain: GainNode | null = null;
  private tyreSource: AudioBufferSourceNode | null = null;
  private tyreFilter: BiquadFilterNode | null = null;

  private started = false;
  private volume = 0.7;
  private enabled = true;

  /** Safe to call repeatedly; only the first call builds the graph. */
  init(volume: number, enabled: boolean): void {
    this.volume = volume;
    this.enabled = enabled;
    if (this.started || !enabled) return;
    if (typeof window === "undefined") return;

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    try {
      this.context = new Ctor();
    } catch {
      return;
    }

    const ctx = this.context;
    this.master = ctx.createGain();
    this.master.gain.value = volume;
    this.master.connect(ctx.destination);

    // --- engine ------------------------------------------------------------
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 3.5;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.oscA = ctx.createOscillator();
    this.oscA.type = "sawtooth";
    this.oscA.frequency.value = IDLE_HZ;

    // Detuned second oscillator gives the note body; a single saw sounds like a
    // kazoo.
    this.oscB = ctx.createOscillator();
    this.oscB.type = "square";
    this.oscB.frequency.value = IDLE_HZ * 1.008;

    this.oscA.connect(this.engineFilter);
    this.oscB.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.oscA.start();
    this.oscB.start();

    // --- tyres -------------------------------------------------------------
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = "bandpass";
    this.tyreFilter.frequency.value = 2400;
    this.tyreFilter.Q.value = 1.1;

    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;

    this.tyreSource = ctx.createBufferSource();
    this.tyreSource.buffer = this.createNoiseBuffer(ctx, 2);
    this.tyreSource.loop = true;
    this.tyreSource.connect(this.tyreFilter);
    this.tyreFilter.connect(this.tyreGain);
    this.tyreGain.connect(this.master);
    this.tyreSource.start();

    this.started = true;
  }

  private createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Simple LCG: this is view-only audio, so a cheap deterministic noise is
    // fine and keeps `Math.random` out of the codebase entirely.
    let seed = 0x2f6e2b1;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff - 1) * 0.6;
    }
    return buffer;
  }

  /** Must be triggered by a user gesture on iOS and Chrome. */
  async resume(): Promise<void> {
    if (!this.context) return;
    if (this.context.state === "suspended") {
      try {
        await this.context.resume();
      } catch {
        // Not fatal — the player simply has no sound until the next gesture.
      }
    }
  }

  suspend(): void {
    void this.context?.suspend();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.master) this.master.gain.value = 0;
    else if (this.master) this.master.gain.value = this.volume;
  }

  /**
   * Drive the synth from telemetry. Called once per rendered frame.
   *
   * Ramps rather than direct assignments: stepping a frequency every frame
   * produces audible zipper noise.
   */
  update(rpm: number, throttle: number, slip: number, speed: number): void {
    if (!this.started || !this.context || !this.enabled) return;
    const now = this.context.currentTime;

    const targetHz = lerp(IDLE_HZ, REDLINE_HZ, clamp(rpm, 0, 1));
    if (this.oscA && this.oscB) {
      this.oscA.frequency.setTargetAtTime(targetHz, now, 0.04);
      this.oscB.frequency.setTargetAtTime(targetHz * 1.008, now, 0.04);
    }

    if (this.engineFilter) {
      // Opening the filter with throttle is what makes it sound like load
      // rather than just pitch.
      const cutoff = lerp(620, 4200, clamp(rpm * 0.65 + throttle * 0.35, 0, 1));
      this.engineFilter.frequency.setTargetAtTime(cutoff, now, 0.06);
    }

    if (this.engineGain) {
      const level = 0.06 + throttle * 0.1 + clamp(rpm, 0, 1) * 0.05;
      this.engineGain.gain.setTargetAtTime(level, now, 0.05);
    }

    if (this.tyreGain && this.tyreFilter) {
      const slipAmount = clamp((slip - 0.12) / 0.55, 0, 1);
      const speedAmount = clamp(speed / 25, 0, 1);
      this.tyreGain.gain.setTargetAtTime(slipAmount * speedAmount * 0.16, now, 0.05);
      this.tyreFilter.frequency.setTargetAtTime(
        lerp(1500, 3400, slipAmount),
        now,
        0.08,
      );
    }
  }

  /** One-shot impact thud. `severity` is impact speed in m/s. */
  impact(severity: number): void {
    if (!this.started || !this.context || !this.master || !this.enabled) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const strength = clamp(severity / 20, 0.1, 1);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(strength * 0.34, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  /** Countdown beep. Rising tone on the final light. */
  beep(final: boolean): void {
    if (!this.started || !this.context || !this.master || !this.enabled) return;
    const ctx = this.context;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = final ? 880 : 440;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (final ? 0.5 : 0.16));

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + (final ? 0.55 : 0.2));
  }

  dispose(): void {
    this.oscA?.stop();
    this.oscB?.stop();
    this.tyreSource?.stop();
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.started = false;
  }
}
