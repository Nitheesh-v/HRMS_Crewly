// Auth & Onboarding UX redesign (Figma reference) — source pins.
//
// Convention: these tests READ the source files and assert the contract,
// the same way every other frontend test in this repo does. They pin the
// decisions the redesign made against the Figma export:
//
//   · real backend contract on the wire (company code + email + password),
//   · remember-me stores identifiers ONLY, never the password,
//   · no social login buttons and no fake social proof (testimonials,
//     stats, emojis) on the auth screens,
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

test("no social login, fake testimonials, fake stats or emojis on auth screens", async () => {
  for (const rel of AUTH_FILES) {
    const src = await read(rel);

    assert.doesNotMatch(src, /Google|Apple/, `${rel} must not render social login`);
    assert.doesNotMatch(src, /Or (login|register) with/, `${rel} must not render the social divider`);
    assert.doesNotMatch(src, /Katie Waters|Total Employees|Job Applicants/, `${rel} must not carry fake social proof`);
    assert.doesNotMatch(src, /login-hero/, `${rel} must not use the stock hero photo`);
    assert.doesNotMatch(src, /[\u{1F000}-\u{1FAFF}]/u, `${rel} must not use emojis in product UI`);
  }
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
