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

const PasswordField = ({ name = "password", value, onChange, required = true, placeholder = "Input your password", autoComplete = "current-password", minLength, maxLength, id }) => {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        className="auth-input pr-12"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        required={required}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={maxLength}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-300"
      >
        <EyeIcon off={visible} />
      </button>
    </div>
  );
};

export default PasswordField;
