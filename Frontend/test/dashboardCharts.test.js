// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD CHARTS — pins for the hand-drawn SVG primitives.
//
// The dashboard shows a month of attendance, a year of leave quotas and a
// week of hours. None of that justified a charting dependency: four small SVG
// components cover it, they animate with CSS the app already ships, and every
// figure stays a number the API actually returned.
//
// What is pinned here:
//   1. the primitives exist and stay dependency-free;
//   2. the dashboard uses them, with data derived from the overview payload;
//   3. the motion is CSS-only and sits behind reduced-motion;
//   4. a graph with nothing to draw falls back to the shared empty state.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const CHARTS = {
  donut: 'src/components/charts/DonutChart.jsx',
  bars: 'src/components/charts/BarChart.jsx',
  stacked: 'src/components/charts/StackedBar.jsx',
  ring: 'src/components/charts/RingGauge.jsx',
};

const dashboard = read('src/pages/dashboard/DashboardPage.jsx');
const css = read('src/style.css');
const pkg = JSON.parse(read('package.json'));

describe('chart primitives', () => {
  test('all four exist and are plain SVG/DOM — no charting library', () => {
    for (const file of Object.values(CHARTS)) {
      assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
    }
    const banned = ['recharts', 'chart.js', 'react-chartjs-2', 'd3', 'apexcharts', 'echarts', 'victory'];
    for (const name of banned) {
      assert.ok(!(pkg.dependencies || {})[name], `${name} must not be added as a dependency`);
    }
  });

  test('the donut draws arcs from percentages, not from a library scale', () => {
    const donut = read(CHARTS.donut);
    assert.ok(donut.includes('pathLength={100}'), 'arcs are expressed in percentages');
    assert.ok(donut.includes('strokeDasharray'), 'segments are stroke dashes');
    assert.ok(!donut.includes('<canvas'), 'vector, so it stays sharp on every screen');
  });

  test('the donut keeps its numbers readable without colour', () => {
    const donut = read(CHARTS.donut);
    assert.ok(donut.includes('aria-hidden="true"'), 'the ring is decoration');
    assert.ok(donut.includes('sr-only'), 'the label carries the same facts as text');
    assert.ok(donut.includes('export const DonutLegend'), 'the legend is the accessible view');
  });

  test('the bar chart states its values twice — as bars and as text', () => {
    const bars = read(CHARTS.bars);
    assert.ok(bars.includes('role="img"'));
    assert.ok(bars.includes('aria-label='));
    assert.ok(bars.includes('valueFormatter'), 'values are printed above each bar');
  });

  test('the stacked bar never divides by zero on an empty period', () => {
    const stacked = read(CHARTS.stacked);
    assert.ok(stacked.includes('total > 0'), 'no parts, no bar — the caller shows the empty state');
    assert.ok(stacked.includes('export const SplitRow'), 'the labelled row is the same bar with a caption');
  });

  test('the ring gauge clamps to 0–100%', () => {
    const ring = read(CHARTS.ring);
    assert.ok(ring.includes('Math.min(100'), 'a week over target must not overdraw the ring');
    assert.ok(ring.includes('Math.max(0'));
  });
});

describe('dashboard wiring', () => {
  test('the dashboard renders the charts', () => {
    assert.ok(dashboard.includes("from '../../components/charts/DonutChart.jsx'"));
    assert.ok(dashboard.includes("from '../../components/charts/StackedBar.jsx'"));
    assert.ok(dashboard.includes("from '../../components/charts/RingGauge.jsx'"));
    assert.ok(dashboard.includes("from '../../components/charts/BarChart.jsx'"));
  });

  test('every slice comes from the overview payload', () => {
    for (const field of ['attendance', 'leaveBalance', 'present', 'late', 'halfDay', 'absent']) {
      assert.ok(dashboard.includes(field), `attendance chart must read ${field}`);
    }
    assert.ok(dashboard.includes('data?.leaveBalance'));
    assert.ok(dashboard.includes('weekTarget'), 'the weekly goal ring reads the weekly-target endpoint');
    assert.ok(!/Math\.random|mockData|sampleData|fake/i.test(dashboard), 'no invented series');
  });

  test('a chart with nothing to draw uses the shared empty state', () => {
    const graph = dashboard.slice(dashboard.indexOf('Attendance this month'));
    assert.ok(graph.includes('illustration="calendar"'));
    assert.ok(dashboard.includes('illustration="tasks"'), 'pending tasks');
    assert.ok(dashboard.includes('illustration="bell"'), 'announcements');
  });
});

describe('chart motion', () => {
  test('bars, splits, segments and rings animate from CSS only', () => {
    for (const rule of ['.chart-bar', '.chart-split', '.chart-segment', '.chart-ring']) {
      assert.ok(css.includes(rule), `missing motion rule: ${rule}`);
    }
    assert.ok(css.includes('@keyframes chart-grow-y'));
    assert.ok(css.includes('@keyframes chart-grow-x'));
    assert.ok(css.includes('@keyframes chart-settle'));
  });

  test('motion is inside the reduced-motion guard', () => {
    // Scope to the chart block: the page also has a landing motion layer whose
    // own guard sits further down the file.
    const start = css.indexOf('CHARTS — hand-drawn');
    const end = css.indexOf('/* 13) Public home');
    const section = css.slice(start, end > start ? end : undefined);

    assert.ok(section.includes('@media (prefers-reduced-motion: no-preference)'));
    for (const selector of ['.chart-bar {', '.chart-split {', '.chart-ring {']) {
      assert.ok(section.includes(selector), `${selector} must live in the chart block`);
      assert.ok(
        section.indexOf(selector) > section.indexOf('prefers-reduced-motion: no-preference'),
        `${selector} must sit inside the no-preference guard`,
      );
    }
  });
});

describe('illustration motion', () => {
  test('scenes carry the classes the stylesheet animates', () => {
    const art = read('src/components/common/EmptyIllustration.jsx');
    for (const className of [
      'empty-art',
      'empty-art-float',
      'empty-art-halo',
      'empty-art-orbit',
      'empty-art-dot',
    ]) {
      assert.ok(art.includes(className), `art module must emit ${className}`);
      assert.ok(css.includes(`.${className}`), `stylesheet must style ${className}`);
    }
  });

  test('a paused frame is still the finished drawing', () => {
    const start = css.indexOf('EMPTY-STATE ART');
    const end = css.indexOf('CHARTS — hand-drawn');
    const artSection = css.slice(start, end > start ? end : undefined);

    assert.ok(artSection.includes('@media (prefers-reduced-motion: no-preference)'));
    // Only opacity/transform are animated, so nothing depends on motion to be legible.
    for (const keyframe of ['empty-art-in', 'empty-art-float', 'empty-art-breathe', 'empty-art-turn', 'empty-art-twinkle']) {
      const at = css.indexOf(`@keyframes ${keyframe}`);
      assert.ok(at > 0, `missing ${keyframe}`);
    }
    assert.ok(!/animation:[^;]*\b(display|visibility|height|width):/.test(artSection));
  });

  test('every scene sits on its own colour pair', () => {
    const art = read('src/components/common/EmptyIllustration.jsx');
    const plates = [...art.matchAll(/<Plate tone=\{(\w+)\} alt=\{(\w+)\} \/>/g)];
    assert.equal(plates.length, 14, 'every scene passes a tone pair');
    assert.ok(!/<Plate \/>/.test(art), 'no scene falls back to a grey plate');
    const pairs = new Set(plates.map((match) => `${match[1]}-${match[2]}`));
    assert.ok(pairs.size >= 8, 'the scenes do not repeat one colour everywhere');
  });
});
