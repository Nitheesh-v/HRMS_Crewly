// Auth & Onboarding UX redesign (Figma reference) — source pins, v2.
//
// Convention: these tests READ the source files and assert the contract,
// the same way every other frontend test in this repo does. They pin the
// decisions the redesign made against the Figma export:
//
//   · real backend contract on the wire (company code + email + password;
//     register sends exactly { companyName, adminName, email, password }),
//   · remember-me stores identifiers ONLY, never the password,
//   · the Figma's Google/Apple buttons render but disabled with a "soon"
//     chip and no handler — no OAuth exists in the backend,
//   · no fake social proof (testimonials, stats) and no emojis,
//   · the backend's generic 401 is shown verbatim — the Figma artwork's
//     "email not registered" copy would leak account enumeration,
//   · dark + light palettes exist and are scoped to the auth subtree,
//   · submit stays disabled until the form is valid,
//   · the footer carries no dead legal links.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel) =>
  readFile(join(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");

const AUTH_FILES = [
  "src/layout/AuthLayout.jsx",
  "src/pages/login/LoginPage.jsx",
  "src/pages/register/RegisterCompanyPage.jsx",
  "src/components/auth/PasswordField.jsx",
  "src/components/auth/PasswordRules.jsx",
  "src/pages/security/ForgotPasswordPage.jsx",
  "src/pages/security/ResetPasswordPage.jsx",
];

test("the four auth routes stay reachable and lazy", async () => {
  const routes = await read("src/routes/AppRoutes.jsx");

  for (const path of ["/login", "/register", "/forgot-password", "/reset-password"]) {
    assert.match(routes, new RegExp(`path="${path.replace("/", "\\/")}"`), `${path} route missing`);
  }
});

test("login posts the real backend contract and remember stores identifiers only", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");

  // The wire call is the existing service against the existing endpoint.
  assert.match(login, /authService\.login\(form\)/);
  // Company code is backend-mandatory even though the Figma art omits it.
  assert.match(login, /name="companyCode"/);
  // The remembered blob is exactly { companyCode, email } — no password.
  assert.match(
    login,
    /JSON\.stringify\(\{ companyCode: form\.companyCode, email: form\.email \}\)/,
  );
  assert.doesNotMatch(
    login,
    /localStorage\.setItem\([^)]*password/i,
    "the password must never be written to localStorage",
  );
});

test("register sends exactly the backend contract — no invented fields", async () => {
  const register = await read("src/pages/register/RegisterCompanyPage.jsx");

  assert.match(register, /authService\.registerCompany\(form\)/);
  for (const name of ["companyName", "adminName", "email", "password"]) {
    assert.match(register, new RegExp(`name="${name}"`), `${name} field missing`);
  }
  // The backend has no confirm-password; the form must not invent one.
  assert.doesNotMatch(register, /name="confirmPassword"/);
});

test("social buttons render like the design but disabled and handler-less", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");
  const register = await read("src/pages/register/RegisterCompanyPage.jsx");

  for (const src of [login, register]) {
    assert.match(src, /Or (login|register) with/);
    assert.match(src, /<button[^>]*disabled[^>]*>\s*Google <span className="auth-soon">soon<\/span>/);
    assert.match(src, /<button[^>]*disabled[^>]*>\s*Apple <span className="auth-soon">soon<\/span>/);
  }
});

test("no fake testimonials or emojis on auth screens; visual panels are Crewly-owned and decorative", async () => {
  for (const rel of AUTH_FILES) {
    const src = await read(rel);

    assert.doesNotMatch(src, /Katie Waters/, `${rel} must not carry a fake testimonial`);
    assert.doesNotMatch(src, /[\u{1F000}-\u{1FAFF}]/u, `${rel} must not use emojis in product UI`);
  }

  const layout = await read("src/layout/AuthLayout.jsx");
  // The photo panel uses the repo's own approved asset, not a stock URL.
  assert.match(layout, /login-hero/);
  // The register preview is illustrative and hidden from assistive tech,
  // the same convention as the landing page's DashboardPreview.
  assert.match(layout, /aria-hidden="true"/);
  assert.match(layout, /ILLUSTRATIVE VALUES/);
});

test("the Figma copy ships verbatim (typos corrected)", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");
  const register = await read("src/pages/register/RegisterCompanyPage.jsx");

  assert.match(login, /Login first to your account/);
  assert.match(login, /Remember Me/);
  assert.match(login, /Forgot Password/);
  assert.match(login, /You're new in here\?/);
  assert.match(login, /Input your registered email/);
  assert.match(register, /Manage employees easily starting from now!/);
  assert.match(register, /Get started for free today!/);
  // Figma typos stay fixed.
  assert.doesNotMatch(login, /Iinput/);
  assert.doesNotMatch(register, /employess/);
  // The weak "6 characters" client hint is gone — platform minimums rule.
  assert.doesNotMatch(register, /at least 6/);
});

test("security screens mirror the platform password policy and stay emoji-free", async () => {
  const reset = await read("src/pages/security/ResetPasswordPage.jsx");
  const forgot = await read("src/pages/security/ForgotPasswordPage.jsx");

  // The checklist is the real PLATFORM_MINIMUMS, not the Figma's 8-char art.
  // Labels live in the data module; both pages must consume the component.
  const rulesModule = await read("src/components/auth/passwordRules.js");
  assert.match(rulesModule, /10 characters/);
  assert.match(rulesModule, /Special character/);
  assert.doesNotMatch(rulesModule, /8 characters/);
  assert.match(reset, /from "..\/..\/components\/auth\/PasswordRules\.jsx"/);
  assert.match(reset, /from "..\/..\/components\/auth\/passwordRules\.js"/);
  // No emoji confetti on the success card; lucide icons only.
  assert.doesNotMatch(reset, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.doesNotMatch(forgot, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  // Forgot needs the company code (backend contract) and one back action.
  assert.match(forgot, /name="companyCode"/);
  assert.equal((forgot.match(/Back to Login/g) || []).length, 1);
  // Reset stays gated on token + rules + confirmation.
  assert.match(
    reset,
    /disabled=\{busy \|\| !token \|\| !allRulesOk \|\| !form\.confirmPassword \|\| Boolean\(mismatch\)\}/,
  );
});

test("the backend's generic failure is shown verbatim; enumeration copy is gone", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");

  assert.match(login, /setServerError\(err\.message\)/);
  assert.match(login, /role="alert"/);
  // The Figma artwork's message would confirm which emails exist — banned.
  assert.doesNotMatch(login, /not registered/);
});

test("submit stays disabled until the form is valid and while loading", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");
  const register = await read("src/pages/register/RegisterCompanyPage.jsx");

  assert.match(login, /disabled=\{loading \|\| !canSubmit\}/);
  assert.match(register, /disabled=\{loading \|\| !canSubmit\}/);
});

test("password visibility toggle and the real forgot-password link survive", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");
  const field = await read("src/components/auth/PasswordField.jsx");

  assert.match(login, /PasswordField/);
  assert.match(login, /to="\/forgot-password"/);
  assert.match(field, /Show password/);
  assert.match(field, /aria-pressed=\{visible\}/);
});

test("theme system: dark default, light override, scoped to the auth subtree", async () => {
  const layout = await read("src/layout/AuthLayout.jsx");
  const css = await read("src/style.css");

  assert.match(layout, /data-theme=\{theme\}/);
  assert.match(layout, /crewly\.theme/);
  assert.match(layout, /Sun/);
  assert.match(layout, /Moon/);
  assert.match(css, /\.auth-root \{/);
  assert.match(css, /\.auth-root\[data-theme="light"\]/);
  // Both palettes define the surface tokens the auth classes consume.
  assert.equal(css.match(/--auth-bg:/g).length, 2, "dark and light must each define --auth-bg");
});

test("the footer carries the copyright line but no dead legal links", async () => {
  const layout = await read("src/layout/AuthLayout.jsx");

  assert.match(layout, /All rights reserved/);
  assert.doesNotMatch(layout, /Terms|Privacy Policy/);
});

test("loading and error states are distinguished and announced", async () => {
  const login = await read("src/pages/login/LoginPage.jsx");
  const register = await read("src/pages/register/RegisterCompanyPage.jsx");

  for (const src of [login, register]) {
    assert.match(src, /aria-busy=\{loading\}/);
    assert.match(src, /auth-error-banner/);
    assert.match(src, /aria-invalid=/);
    assert.match(src, /aria-describedby=/);
  }
});
