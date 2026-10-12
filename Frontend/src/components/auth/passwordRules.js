// Platform password minimums — mirrors PLATFORM_MINIMUMS in
// Backend/src/utils/securityPolicy.js (10 chars, upper, lower, number,
// special). The backend stays the authority; this list only saves the
// user a rejected round trip. If the platform minimums ever rise, the
// backend rejects and this list must follow.
//
// Plain data module (no JSX) so PasswordRules.jsx can stay a
// component-only file for fast refresh.
export const passwordRules = (password) => {
  const value = password || "";

  return [
    { label: "10 characters", ok: value.length >= 10 },
    { label: "Uppercase letter (A-Z)", ok: /[A-Z]/.test(value) },
    { label: "Lowercase letter (a-z)", ok: /[a-z]/.test(value) },
    { label: "Number (0-9)", ok: /[0-9]/.test(value) },
    { label: "Special character", ok: /[^A-Za-z0-9]/.test(value) },
  ];
};
