import { useEffect, useId, useRef } from "react";
import {
  X,
  ArrowRight,
  Flame,
  LoaderCircle,
  CircleAlert,
  Check,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/AppContext";
import { statusBn, statusNames } from "../lib/api";

export function Logo({ light = false, small = false }) {
  return (
    <Link
      to="/"
      className={
        "brand" + (light ? " brand-light" : "") + (small ? " brand-small" : "")
      }
      aria-label="Angar Kitchen home"
    >
      <span className="brand-mark">
        <Flame strokeWidth={1.4} />
      </span>
      <span>
        <strong>
          ANGAR<span className="brand-dot">.</span>
        </strong>
        <small>DHAKA KITCHEN</small>
      </span>
    </Link>
  );
}
export function Eyebrow({ children, light = false }) {
  return (
    <p className={"eyebrow" + (light ? " eyebrow-light" : "")}>
      <span />
      {children}
    </p>
  );
}
export function Button({
  children,
  to,
  secondary = false,
  gold = false,
  className = "",
  arrow = false,
  ...props
}) {
  const style =
    "button " +
    (gold ? "button-gold" : secondary ? "button-secondary" : "button-primary") +
    " " +
    className;
  const content = (
    <>
      {children}
      {arrow && <ArrowRight size={17} />}
    </>
  );
  return to ? (
    <Link className={style} to={to} {...props}>
      {content}
    </Link>
  ) : (
    <button className={style} type="button" {...props}>
      {content}
    </button>
  );
}
export function Modal({ open, onClose, title, children, className = "" }) {
  const ref = useRef(null);
  const id = useId();
  useEffect(() => {
    const element = ref.current;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={"dialog " + className}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Loading({ label = "Loading…" }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={22} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function ErrorMessage({ children, onRetry }) {
  return (
    <div className="error-message" role="alert">
      <CircleAlert size={18} />
      <span>{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          <RefreshCw size={15} /> Retry
        </button>
      )}
    </div>
  );
}
export function EmptyState({ icon: Icon = Flame, title, text, children }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={28} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
export function Status({ status }) {
  const { language } = useApp();
  return (
    <span className={"status status-" + status}>
      <span />
      {language === "bn"
        ? statusBn[status] || statusNames[status] || status
        : statusNames[status] || status}
    </span>
  );
}
export function Quantity({
  value,
  onChange,
  disabled = false,
  label = "Quantity",
}) {
  return (
    <div className="quantity-control" aria-label={label}>
      <button
        type="button"
        disabled={disabled}
        aria-label="Decrease quantity"
        onClick={() => onChange(value - 1)}
      >
        <Minus size={15} />
      </button>
      <span>{value}</span>
      <button
        type="button"
        disabled={disabled || value >= 10}
        aria-label="Increase quantity"
        onClick={() => onChange(value + 1)}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
export function Progress({ status }) {
  const { t } = useApp();
  const steps = [
    ["placed", "Received", "জমা হয়েছে"],
    ["queued", "Accepted", "গৃহীত"],
    ["preparing", "Cooking", "রান্না হচ্ছে"],
    ["ready", "Ready", "প্রস্তুত"],
    ["served", "Served", "পরিবেশিত"],
  ];
  const active = steps.findIndex(([id]) => id === status);
  if (active < 0) return null;
  return (
    <ol className="order-progress">
      {steps.map(([id, en, bn], index) => (
        <li
          key={id}
          className={
            index < active ? "done" : index === active ? "current" : ""
          }
          aria-current={index === active ? "step" : undefined}
        >
          <span>{index < active ? <Check size={14} /> : index + 1}</span>
          <small>{t(en, bn)}</small>
        </li>
      ))}
    </ol>
  );
}
