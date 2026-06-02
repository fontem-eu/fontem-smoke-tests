import base from './playwright.config.js'

// Record-mode config — same defaults as the suite, but turns on
// per-test video recording, points artefacts at ./recordings, and
// slows each action down so a human reviewer can actually see what's
// happening as the run progresses.

export default {
  ...base,
  outputDir: './recordings',
  reporter: [['list']],
  retries: 0,
  // Pace each test action so the recording stays followable.
  // Playwright defaults to "as fast as the browser allows" which
  // makes the rendered videos a blur — fine for CI, useless for
  // human review.
  use: {
    ...base.use,
    video: 'on',
    launchOptions: {
      slowMo: 600,
    },
  },
}
