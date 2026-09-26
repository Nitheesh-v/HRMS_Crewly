import React from "react";

// Eye / eye-off toggle for password fields — inline SVG, no icon dependency.
const EyeIcon = ({ off }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <line x1="4" y1="4" x2="20" y2="20" />}
  </svg>
);

// A field the user types into twice per session — the small courtesies matter:
// the toggle is a real button with a label, the character counter appears only
// when a cap is in play, Caps Lock is called out while typing (a classic
// "my password is wrong" that has nothing to do with the password), and the
// field reports its own invalid state so the parent's red text is announced.
const PasswordField = ({
  name = "password",
  value,
  onChange,
  required = true,
  placeholder = "Input your password",
  autoComplete = "current-password",
  minLength,
  maxLength,
  id,
  autoFocus = false,
  invalid = false,
  describedBy,
}) => {
  const [visible, setVisible] = React.useState(false);
  const [capsLock, setCapsLock] = React.useState(false);

  const watchCaps = (event) => {
    if (typeof event.getModifierState !== "function") return;
    setCapsLock(event.getModifierState("CapsLock"));
  };

  return (
    <div>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          className="auth-input pr-12"
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          onKeyDown={watchCaps}
          onKeyUp={watchCaps}
          onBlur={() => setCapsLock(false)}
          required={required}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          minLength={minLength}
          maxLength={maxLength}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 transition-colors hover:text-slate-200 focus-visible:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
        >
          <EyeIcon off={visible} />
        </button>
      </div>

      {capsLock && (
        <p className="mt-1.5 text-[11px] text-amber-300/90" role="status">
          Caps Lock is on.
        </p>
      )}

      {maxLength && value?.length >= maxLength - 20 && (
        <p className="mt-1.5 text-right text-[11px] text-slate-500">
          {value.length}/{maxLength}
        </p>
      )}
    </div>
  );
};

export default PasswordField;
