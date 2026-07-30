"use client";

import { Panel } from "@/components/ui/Panel";
import { Button, ButtonLink } from "@/components/ui/Button";

/**
 * Race route error boundary.
 *
 * The realistic cause is WebGL: a blocked context, an exhausted GPU, or a
 * browser without WebGL 2. That is worth saying plainly rather than showing a
 * blank canvas.
 */
export default function RaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-void p-4">
      <Panel className="w-full max-w-lg p-6 sm:p-8">
        <span className="label text-ember">Engine fault</span>
        <h1 className="mt-2 font-display text-3xl font-bold text-chalk">
          The race could not start
        </h1>
        <p className="mt-3 text-xs leading-relaxed text-fog">
          APEX needs WebGL 2. This usually means the browser blocked the graphics
          context, hardware acceleration is disabled, or too many other tabs are
          holding GL contexts open.
        </p>
        <p className="mt-3 break-words border-l-2 border-steel pl-3 font-mono text-[10px] leading-relaxed text-steel">
          {error.message}
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button variant="primary" size="md" onClick={reset}>
            Try again
          </Button>
          <ButtonLink href="/campaign" variant="secondary" size="md">
            Back to campaign
          </ButtonLink>
        </div>
      </Panel>
    </div>
  );
}
