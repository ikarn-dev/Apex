"use client";

/**
 * Two-line subtitle strip for story beats.
 *
 * Sits low and narrow so it never covers the road, and auto-dismisses — a
 * dialogue box that needs acknowledging mid-corner gets read as an obstacle.
 *
 * Visibility is derived from which beat has been dismissed rather than held in a
 * separate boolean, so arrival of a new line needs no synchronising setState.
 */

import { useEffect, useState } from "react";
import { useRace } from "@/stores/race";
import { cn } from "@/lib/cn";

const SPEAKER_TONE: Record<string, string> = {
  HALO: "text-apex",
  KESTREL: "text-amber",
  VALIDATOR: "text-ember",
  SYSTEM: "text-fog",
};

/** How long a line stays up, ms. */
const DWELL_MS = 5200;
/** Fade duration before the line is dropped from the store, ms. */
const FADE_MS = 300;

export function StoryStrip() {
  const story = useRace((s) => s.story);
  const clearStory = useRace((s) => s.clearStory);

  /** Timestamp of the beat that has begun fading out. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!story) return;
    const dwell = setTimeout(() => {
      // Inside a timeout, so this is not a synchronous setState in an effect.
      setDismissedAt(story.at);
      setTimeout(clearStory, FADE_MS);
    }, DWELL_MS);
    return () => clearTimeout(dwell);
  }, [story, clearStory]);

  if (!story) return null;
  const visible = dismissedAt !== story.at;

  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-[22%] left-1/2 z-20 w-[min(90vw,640px)] -translate-x-1/2 transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="border-l-2 border-apex/60 bg-void/75 px-4 py-3 backdrop-blur-sm">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.2em]",
            SPEAKER_TONE[story.speaker] ?? "text-fog",
          )}
        >
          {story.speaker}
        </span>
        <p className="mt-1.5 text-xs leading-relaxed text-chalk sm:text-sm">
          {story.line}
        </p>
      </div>
    </div>
  );
}
