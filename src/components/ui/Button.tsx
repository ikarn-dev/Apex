import { forwardRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-apex text-void hover:bg-apex/85 active:bg-apex/70 border border-apex disabled:bg-apex/30 disabled:border-apex/30",
  secondary:
    "bg-carbon text-chalk border border-steel hover:border-apex/60 hover:text-apex active:bg-steel",
  ghost:
    "bg-transparent text-fog border border-transparent hover:text-chalk hover:border-steel",
  danger:
    "bg-transparent text-ember border border-ember/40 hover:bg-ember/10 hover:border-ember",
};

const SIZES: Record<Size, string> = {
  // 44px minimum height throughout: these are all touch targets on mobile.
  sm: "h-11 px-4 text-[11px] tracking-[0.16em]",
  md: "h-12 px-6 text-xs tracking-[0.18em]",
  lg: "h-14 px-8 text-sm tracking-[0.2em]",
};

const BASE =
  "inline-flex items-center justify-center gap-2 font-mono uppercase font-medium " +
  "transition-colors duration-150 clip-notch select-none " +
  "disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-apex";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Renders a full-width block. */
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", block, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(BASE, VARIANTS[variant], SIZES[size], block && "w-full", className)}
      {...props}
    />
  );
});

export interface ButtonLinkProps
  extends Omit<React.ComponentProps<typeof Link>, "className"> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  className?: string;
  /** Visually and functionally disable navigation. */
  disabled?: boolean;
}

/** Same visual language as `Button`, for real navigation. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  block,
  className,
  disabled,
  href,
  ...props
}: ButtonLinkProps) {
  const classes = cn(
    BASE,
    VARIANTS[variant],
    SIZES[size],
    block && "w-full",
    disabled && "pointer-events-none opacity-40",
    className,
  );

  if (disabled) {
    return (
      <span className={classes} aria-disabled="true">
        {props.children}
      </span>
    );
  }

  return <Link href={href} className={classes} {...props} />;
}
