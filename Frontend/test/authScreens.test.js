// ═══════════════════════════════════════════════════════════════════════════
// AUTH SCREENS — pins for login, register, forgot and reset.
//
// The auth screens are the first thing a customer sees after the marketing page,
// and they are the easiest place in a product to accidentally lie: a
// "Continue with Google" button for an OAuth provider nobody configured, a
// quoted customer who does not exist, or a consent line naming documents the
// company never published.
//
// These checks are about what the screens must NOT do, plus the few structural
// facts the redesign depends on (one shared layout, one shared input class).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const AUTH_PAGES = [
  'src/pages/login/LoginPage.jsx',
  'src/pages/register/RegisterCompanyPage.jsx',
  'src/pages/security/ForgotPasswordPage.jsx',
  'src/pages/security/ResetPasswordPage.jsx',
];

describe('Auth screens — honesty', () => {
  test('there is no OAuth button, because there is no OAuth provider', () => {
    // The reference design has "Sign up with Google" as its most prominent
    // control. Nothing in Backend/src implements a Google flow, so the button
    // would be the one control on the page that cannot work.
    const backend = fs.readdirSync(path.join(root, '..', 'Backend', 'src', 'controllers'));

    for (const file of AUTH_PAGES) {
      const source = code(file);

      assert.equal(/google/i.test(source), false, `${file} offers a Google sign-in that does not exist`);
      assert.equal(/continue with/i.test(source), false, `${file} invents a provider button`);
    }

    assert.equal(
      backend.some((file) => /oauth|google/i.test(file)),
      false,
      'if OAuth is ever added to the backend, this pin should be replaced by a real test',
    );
  });

  test('no invented customer is quoted on the way in', () => {
    // The old split panel carried "Katie Waters, Head Resource Management" and a
    // testimonial. No such customer exists in this repository.
    for (const file of AUTH_PAGES) {
      const source = code(file);

      for (const fabrication of ['Katie', 'testimonial', 'Amazing Platform']) {
        assert.equal(source.includes(fabrication), false, `${file} still quotes ${fabrication}`);
      }
    }
  });

  test('the legal line says the documents are not published, and links nothing', () => {
    const layout = code('src/layout/AuthLayout.jsx');

    assert.match(layout, /not published/i, 'the auth footer must say the legal pages do not exist yet');
    assert.equal(/href="\/privacy"/.test(layout), false, 'no dead privacy link');
    assert.equal(/href="\/terms"/.test(layout), false, 'no dead terms link');
    assert.equal(
      /to="\/privacy"|to="\/terms"/.test(layout),
      false,
      'no router link to an unpublished page',
    );

    // The register screen used to assert that creating an account meant agreeing
    // to those unpublished documents.
    const register = code('src/pages/register/RegisterCompanyPage.jsx');

    assert.equal(/agree to/i.test(register), false, 'register must not assert unpublished terms');
  });
});

describe('Auth screens — one shell, one set of controls', () => {
  test('every screen renders through AuthLayout, which owns the chrome', () => {
    for (const file of AUTH_PAGES) {
      assert.ok(code(file).includes('<AuthLayout'), `${file} must use the shared auth shell`);
    }

    // PublicLayout used to draw a second header above these screens.
    const publicLayout = code('src/layout/PublicLayout.jsx');

    assert.equal(publicLayout.includes('<header'), false, 'PublicLayout must not draw a second header');
    assert.ok(publicLayout.includes('<Outlet />'), 'it still renders the route');
  });

  test('fields and actions come from the shared auth classes, not one-off copies', () => {
    for (const file of ['src/pages/login/LoginPage.jsx', 'src/pages/register/RegisterCompanyPage.jsx']) {
      const source = code(file);

      assert.ok(source.includes('auth-input') || source.includes('<PasswordField'), `${file} uses the shared input skin`);
      assert.ok(source.includes('auth-primary'), `${file} uses the shared primary action`);
      assert.equal(source.includes('bg-[#10b981]'), false, `${file} must not carry an ad-hoc button colour`);
    }

    const css = read('src/style.css');

    for (const rule of ['.auth-shell', '.auth-display', '.auth-input', '.auth-primary', '.auth-link']) {
      assert.match(css, new RegExp(`\\${rule}\\s*\\{`), `${rule} is defined once, in the auth layer`);
    }

    // The checkbox was a white square on charcoal until the shell declared a
    // dark colour scheme for native controls.
    assert.match(css, /\.auth-shell\s*\{[\s\S]*?color-scheme:\s*dark/, 'native controls are dark');
  });

  test('every field has a label, and the password field keeps its toggle', () => {
    for (const file of ['src/pages/login/LoginPage.jsx', 'src/pages/register/RegisterCompanyPage.jsx']) {
      const source = code(file);
      const ids = [...source.matchAll(/<input[\s\S]*?id="([\w]+)"/g)].map((match) => match[1]);

      assert.ok(ids.length >= 2, `${file} has inputs`);

      for (const id of ids) {
        assert.ok(source.includes(`htmlFor="${id}"`), `${file}: no label for #${id}`);
      }
    }

    const field = code('src/components/auth/PasswordField.jsx');

    assert.ok(field.includes('aria-label'), 'the show/hide toggle is labelled');
    assert.ok(field.includes('aria-pressed'), 'and it reports its state');
  });

  test('the illustration is decoration, and it moves only if the visitor allows it', () => {
    const art = code('src/components/auth/AuthArt.jsx');
    const css = read('src/style.css');

    assert.ok(art.includes('aria-hidden="true"'), 'the sketch must not be read out');
    assert.ok(art.includes('<svg'), 'the scene is inline SVG — no image request');
    assert.equal(/<img/.test(art), false, 'no bitmap asset to load or fail');

    // The float is opt-in; the reduced-motion media query is the guard.
    assert.match(
      css,
      /@media \(prefers-reduced-motion: no-preference\)[\s\S]*?@keyframes auth-float/,
      'the drift lives inside the reduced-motion guard',
    );
  });
});
