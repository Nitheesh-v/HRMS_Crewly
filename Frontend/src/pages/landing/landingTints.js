// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE TINT FAMILIES.
//
// Four paper stocks, one map. Sections cycle through `tintAt(index)` so a grid
// of cards comes out in four colours without any card inventing a shade, and a
// colour means the same thing wherever it appears: lilac is the action family,
// sage is calm, amber is "in progress", clay is the warm counterweight.
//
// This lives beside landingStyles.js rather than inside it because that module
// is scanned by the focus-ring test as a list of CLASS STRINGS; an object and a
// helper function would (correctly) trip it.
// ═══════════════════════════════════════════════════════════════════════════

// One entry per colour family. `surface` is the card, `chip` is the icon tile,
// `ink` is the one text colour that is allowed on that surface. Sections cycle
// through this map by index, so six cards get six different paper stocks
// without any of them inventing a colour.
export const TINTS = {
  lilac: {
    surface: 'border-crewly-lilac-deep/45 bg-crewly-lilac/45',
    chip: 'border-crewly-lilac-deep/60 bg-crewly-lilac text-crewly-forest',
    ink: 'text-crewly-forest',
    dot: 'bg-crewly-lilac-deep',
  },
  sage: {
    surface: 'border-crewly-sage-deep/25 bg-crewly-sage/45',
    chip: 'border-crewly-sage-deep/30 bg-crewly-sage text-crewly-sage-deep',
    ink: 'text-crewly-sage-deep',
    dot: 'bg-crewly-sage-deep',
  },
  amber: {
    surface: 'border-crewly-amber/45 bg-crewly-amber-soft/80',
    chip: 'border-crewly-amber/60 bg-crewly-amber/40 text-crewly-amber-deep',
    ink: 'text-crewly-amber-deep',
    dot: 'bg-crewly-amber',
  },
  clay: {
    surface: 'border-crewly-clay/30 bg-crewly-clay-soft/70',
    chip: 'border-crewly-clay/40 bg-crewly-clay/20 text-crewly-clay-deep',
    ink: 'text-crewly-clay-deep',
    dot: 'bg-crewly-clay',
  },
};

export const tintCycle = ['lilac', 'clay', 'sage', 'amber'];

export const tintAt = (index) => TINTS[tintCycle[index % tintCycle.length]];
