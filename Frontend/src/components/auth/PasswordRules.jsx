import { CheckCircle2, XCircle } from "lucide-react";
import { passwordRules } from "./passwordRules.js";

// Figma's requirements checklist, themed: met rules read green with a
// check, unmet rules read red with an x — text plus icon, never colour
// alone.
const PasswordRules = ({ password }) => (
  <ul
    className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2"
    aria-label="Password requirements"
  >
    {passwordRules(password).map((rule) => (
      <li
        key={rule.label}
        className={`flex items-center gap-1.5 text-xs ${
          rule.ok ? "auth-check" : "auth-error-text"
        }`}
      >
        {rule.ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {rule.label}
      </li>
    ))}
  </ul>
);

export default PasswordRules;
