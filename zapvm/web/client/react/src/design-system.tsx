import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function BrandMark({ className, title = "zapVM" }: { className?: string; title?: string }) {
  return <svg className={cx("brand-symbol", className)} viewBox="0 0 32 32" role="img" aria-label={title}>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" />
    <path d="M9.25 9.75h13.5L9.25 22.25h13.5" fill="none" stroke="#0a0d0f" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" />
    <circle cx="9.25" cy="9.75" r="1.6" fill="#0a0d0f" />
    <circle cx="22.75" cy="22.25" r="1.6" fill="#0a0d0f" />
  </svg>;
}

export function BrandLockup({ compact = false, className }: { compact?: boolean; className?: string }) {
  return <span className={cx("brand-lockup", compact && "compact", className)}>
    <BrandMark />
    <span className="brand-wordmark"><strong>zapVM</strong>{!compact && <small>AGENT COMPUTER</small>}</span>
  </span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
};

export function Button({ tone = "secondary", size = "md", fullWidth, leadingIcon, className, children, ...props }: ButtonProps) {
  return <button className={cx("ds-button", `ds-button-${tone}`, `ds-button-${size}`, fullWidth && "ds-button-block", className)} {...props}>
    {leadingIcon}<span>{children}</span>
  </button>;
}

export function IconButton({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cx("ds-icon-button", className)} {...props}>{children}</button>;
}

export function StatusDot({ tone = "neutral", pulse = false, className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "active" | "success" | "danger" | "warning"; pulse?: boolean }) {
  return <span className={cx("ds-status-dot", `is-${tone}`, pulse && "is-pulsing", className)} aria-hidden="true" {...props} />;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "active" | "success" | "danger"; className?: string }) {
  return <span className={cx("ds-badge", `ds-badge-${tone}`, className)}>{children}</span>;
}
