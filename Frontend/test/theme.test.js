// ═══════════════════════════════════════════════════════════════════════════
// THEME — the light "warm paper" theme and the switch that turns it on.
//
// What is pinned here:
//   1. the switch is one attribute, and it is written before the first paint;
//   2. the choice is remembered, and defaults to the app's night theme;
//   3. the light palette is a token override, not a parallel stylesheet — so
//      every screen that already reads the tokens changes with it;
//   4. the light palette is actually readable (contrast is computed from the
//      hexes in the CSS, not asserted by eye);
//   5. the surfaces that own their palette — public home, auth, provider
//      console — are exempt from the switch;
//   6. no component went back to the dark-only `white/5` trick.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const css = read('src/style.css');
const html = read('index.html');
const themeUtil = read('src/utils/theme.js');
const hook = read('src/hooks/useTheme.js');
const toggle = read('src/components/common/ThemeToggle.jsx');
const appLayout = read('src/layout/AppLayout.jsx');

const lightAt = css.indexOf("html[data-theme='light'] {");
const lightBlock = lightAt > -1 ? css.slice(lightAt, css.indexOf('\n}', lightAt)) : '';
const token = (name) => {
  const match = lightBlock.match(new RegExp(`--color-crewly-${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
};

/** Only the solid colours participate in the contrast/warmth checks; the insets
 *  and hairlines are translucent brown, which is warm by construction. */
const hexToken = (name) => {
  const value = token(name);
  return value && value.startsWith('#') ? value : null;
};

/** WCAG relative luminance, so "readable" is a number and not an opinion. */
const luminance = (hex) => {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

describe('theme switch — no flash, and it is remembered', () => {
  test('index.html applies the stored choice before any app code runs', () => {
    const scriptAt = html.indexOf('crewly-theme');
    const moduleAt = html.indexOf('type="module"');

    assert.ok(scriptAt > -1, 'the pre-paint script reads the same storage key the app writes');
    assert.ok(moduleAt > -1, 'the app entry is still a module script');
    assert.ok(scriptAt < moduleAt, 'the theme must be resolved before the bundle is even requested');
    assert.match(html, /setAttribute\("data-theme", "light"\)/, 'light is the only attribute value: dark is the default');
    assert.match(html, /try\s*\{/, 'storage can throw in private modes — the boot script must survive it');
    assert.match(html, /meta\[name="theme-color"\]/, 'the mobile browser chrome follows the theme too');
  });

  test('dark is the default and only two themes exist', () => {
    assert.match(themeUtil, /export const THEME_STORAGE_KEY = 'crewly-theme'/);
    assert.match(themeUtil, /export const DEFAULT_THEME = DARK/);
    assert.match(themeUtil, /value === DARK \|\| value === LIGHT/);
    assert.match(themeUtil, /if \(next === DARK\) root\.removeAttribute\('data-theme'\)/, 'dark stays the unmarked default');
  });

  test('the choice survives a reload and follows a second tab', () => {
    assert.match(themeUtil, /localStorage\.setItem\(THEME_STORAGE_KEY, next\)/);
    assert.match(themeUtil, /localStorage\.getItem\(THEME_STORAGE_KEY\)/);
    assert.match(themeUtil, /addEventListener\('storage'/, 'two open tabs must not disagree about the theme');
    assert.match(themeUtil, /catch \{[\s\S]{0,120}?\}/, 'storage failures are contained');
  });

  test('one control, driven by shared state rather than local copies', () => {
    assert.match(hook, /useSyncExternalStore/);
    assert.match(hook, /subscribeTheme/);
    assert.match(toggle, /import \{ Moon, Sun \} from 'lucide-react'/);
    assert.match(toggle, /aria-label=\{`Switch to \$\{next\} theme`\}/, 'the label names the action, not the icon');
    assert.match(toggle, /data-theme-state=\{theme\}/);
    assert.match(appLayout, /import ThemeToggle from "\.\.\/components\/common\/ThemeToggle\.jsx"/);
    assert.equal(
      appLayout.split('<ThemeToggle />').length - 1,
      1,
      'the header mounts the switch exactly once',
    );
    assert.ok(
      appLayout.indexOf('<ThemeToggle />') < appLayout.indexOf('<NotificationBell />', appLayout.indexOf('<ThemeToggle />')),
      'it sits with the other header controls',
    );
  });

  test('the public and auth surfaces never mount it', () => {
    for (const file of ['src/pages/landing/LandingHeader.jsx', 'src/layout/AuthLayout.jsx']) {
      assert.equal(read(file).includes('ThemeToggle'), false, `${file} must not offer the app theme switch`);
    }
  });
});

describe('light palette — warm paper, from tokens', () => {
  test('the override block exists, before the landing motion layer', () => {
    assert.ok(lightAt > -1, 'there is a light theme block');
    const layerAt = css.indexOf('13) Public home — the motion layer');
    assert.ok(layerAt > -1, 'the landing motion layer is still the last block');
    assert.ok(lightAt < layerAt, 'theme CSS must not be appended after the landing layer');
    assert.match(lightBlock, /color-scheme: light/, 'native controls are painted for paper, not for night');
  });

  test('every app token is re-declared, so no screen keeps a dark value', () => {
    for (const name of ['bg', 'card', 'border', 'text', 'dim', 'green', 'orange', 'red', 'accent']) {
      assert.ok(hexToken(name), `--color-crewly-${name} has a light value`);
    }
    for (const name of ['inset', 'inset-strong', 'inset-heavy', 'hairline', 'hairline-strong']) {
      assert.ok(token(name), `--color-crewly-${name} has a light value`);
    }
  });

  test('it is brown, not grey', () => {
    // Warm means red > green > blue in every neutral step. A neutral ramp would
    // have r == g == b, which is exactly the template look this replaces.
    const warm = (hex) => {
      const value = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
      return r > g && g > b;
    };

    for (const name of ['bg', 'card', 'border', 'text', 'dim']) {
      assert.ok(warm(hexToken(name)), `--color-crewly-${name} (${hexToken(name)}) leans warm`);
    }

    // The translucent surfaces are brown too: red channel highest, blue lowest.
    const channels = token('inset').match(/[\d.]+/g).slice(0, 3).map(Number);
    assert.ok(channels[0] > channels[1] && channels[1] > channels[2], `inset (${token('inset')}) is a warm brown`);
    assert.equal(hexToken('bg'), '#f6efe4', 'the canvas is paper, not white');
    assert.equal(hexToken('card'), '#fffbf4', 'cards are the same paper, a shade lighter');
  });

  test('the slate ramp is inverted and stays warm', () => {
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const value = (step) => {
      const match = lightBlock.match(new RegExp(`--color-slate-${step}:\\s*(#[0-9a-fA-F]{6})`));
      return match ? match[1] : null;
    };

    for (const step of steps) assert.ok(value(step), `slate-${step} is re-declared`);

    // 950 was the deepest night surface; it is now the lightest paper.
    assert.ok(luminance(value(950)) > 0.9, 'slate-950 became the lightest step');
    assert.ok(luminance(value(50)) < 0.05, 'slate-50 became the darkest ink');
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(
        luminance(value(steps[i - 1])) < luminance(value(steps[i])),
        `slate-${steps[i]} must be lighter than slate-${steps[i - 1]} after the flip`,
      );
    }
  });

  test('text on paper clears WCAG AA', () => {
    const bg = hexToken('bg');
    const card = hexToken('card');
    const slate = (step) => {
      const match = lightBlock.match(new RegExp(`--color-slate-${step}:\\s*(#[0-9a-fA-F]{6})`));
      return match ? match[1] : null;
    };

    const pairs = [
      ['text', hexToken('text'), bg],
      ['text on card', hexToken('text'), card],
      ['dim', hexToken('dim'), bg],
      ['dim on card', hexToken('dim'), card],
      ['green', hexToken('green'), bg],
      ['orange', hexToken('orange'), bg],
      ['red', hexToken('red'), bg],
      ['slate-500 (secondary copy)', slate(500), bg],
      ['slate-400', slate(400), bg],
      ['slate-300', slate(300), bg],
    ];

    for (const [label, foreground, background] of pairs) {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= 4.5, `${label} is ${ratio.toFixed(2)}:1 on paper, needs 4.5:1`);
    }

    // The same accents are also button *fills* with light type on top.
    assert.ok(contrast(hexToken('green'), bg) >= 4.5, 'a green button still carries light type');
    assert.ok(contrast(hexToken('accent'), '#ffffff') >= 4.5, 'the clay action button carries white type');
  });

  test('status hues flip far enough to read on paper', () => {
    const at = css.indexOf("html[data-theme='light'] {");
    const light = css.slice(at, css.indexOf('\n}', at));
    const after = css.indexOf(':is(.landing-shell, .auth-shell, .theme-fixed-dark)');
    const dark = css.slice(after, css.indexOf('\n}', after));

    const valueOf = (body, family, step) => {
      const match = body.match(new RegExp(`--color-${family}-${step}:\\s*([^;]+);`));
      return match ? match[1].trim() : null;
    };
    // oklch carries its own lightness; the handful of tokens Tailwind never
    // emitted (so it could not be read from the build) are plain hex.
    const oklchL = (value) => {
      const match = value && value.match(/^oklch\(([\d.]+)%/);
      return match ? Number(match[1]) : null;
    };

    const families = ['emerald', 'indigo', 'amber', 'rose', 'sky', 'red', 'blue', 'green'];

    for (const family of families) {
      const lightSteps = [100, 200, 300, 400].map((step) => [step, valueOf(light, family, step)]).filter(([, v]) => v);
      assert.ok(lightSteps.length >= 1, `${family} has light-theme steps`);

      for (const [step, value] of lightSteps) {
        const original = valueOf(dark, family, step);
        assert.ok(original, `${family}-${step} keeps its dark value in the fixed-palette carve-out`);
        assert.notEqual(value, original, `${family}-${step} must be rewritten for paper`);

        const [lightL, darkL] = [oklchL(value), oklchL(original)];
        if (lightL !== null && darkL !== null) {
          assert.ok(
            lightL < darkL - (step === 400 ? 12 : 20),
            `${family}-${step} must darken sharply (${darkL}% -> ${lightL}%), or 300-level badges vanish on paper`,
          );
        } else if (value.startsWith('#')) {
          const ratio = contrast(value, '#f6efe4');
          assert.ok(
            ratio >= (step === 400 ? 3 : 4.5),
            `${family}-${step} (${value}) is ${ratio.toFixed(2)}:1 on paper`,
          );
        }
      }

      // 500/600 are the button fills: light type sits on them, so they stay.
      assert.equal(valueOf(light, family, 500), null, `${family}-500 must not be remapped`);
    }
  });

  test('surface colours that are already light are literals, not theme tokens', () => {
    // `bg-emerald-100 text-emerald-700` reads as a paper chip. Once the ramp
    // flips, the same pair is ink on ink, so those chips carry their own hexes.
    assert.ok(css.includes('--color-emerald-100:'), 'the ramp still flips for text');
    for (const file of [
      'src/components/TaskDetailModal.jsx',
      'src/pages/projects/ProjectsPage.jsx',
      'src/pages/payroll/PayslipDocument.jsx',
    ]) {
      const source = read(file);
      assert.equal(
        /\bbg-(emerald|amber|blue|green|red|orange|slate)-(50|100)\b/.test(source),
        false,
        `${file} must not build a light chip out of an inverting step`,
      );
    }
  });

  test('the SVG primitives read their colours from the theme', () => {
    assert.match(read('src/components/charts/DonutChart.jsx'), /stroke="var\(--chart-track\)"/);
    assert.match(read('src/components/charts/RingGauge.jsx'), /trackColor = 'var\(--chart-track\)'/);
    assert.match(read('src/components/charts/StackedBar.jsx'), /bg-crewly-inset/);
    assert.match(read('src/components/common/EmptyIllustration.jsx'), /rgba\(var\(--art-ink-rgb\)/);
    assert.match(css, /html\[data-theme='light'\] \{[\s\S]*?--chart-track:/);
    assert.match(css, /html\[data-theme='light'\] \{[\s\S]*?--art-plate:/);
  });
});

describe('palette ownership', () => {
  test('the three fixed-palette surfaces opt out of the switch', () => {
    assert.match(
      css,
      /html\[data-theme='light'\] :is\(\.landing-shell, \.auth-shell, \.theme-fixed-dark\)/,
      'landing, auth and the provider console keep their own values',
    );
    assert.match(read('src/layout/SuperAdminLayout.jsx'), /className="theme-fixed-dark /);
  });

  test('the wordmark knows which way to blend', () => {
    assert.match(css, /\.crewly-logo \{\s*mix-blend-mode: screen;/);
    assert.match(css, /html\[data-theme='light'\] \.crewly-logo \{\s*mix-blend-mode: multiply;/);
    const sidebar = read('src/layout/SidebarNav.jsx');
    assert.equal(sidebar.includes('mix-blend-screen'), false, 'the utility would out-rank the theme rule');
    assert.equal(sidebar.split('crewly-logo').length - 1, 2, 'both logo instances are theme-aware');
  });

  test('no component still builds surfaces out of dark-only white alphas', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!rel.startsWith('src/pages/landing') && !rel.startsWith('src/components/auth')) walk(rel);
          continue;
        }
        if (!entry.name.endsWith('.jsx')) continue;
        const source = read(rel);
        if (/\b(bg|border)-white\/(5|10|20)\b/.test(source)) offenders.push(rel);
      }
    };

    walk('src');
    assert.deepEqual(offenders, [], 'use bg-crewly-inset / border-crewly-hairline instead');
  });
});
