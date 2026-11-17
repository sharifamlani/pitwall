// Stub: the real list and scrub arrive in the green commit.
const ELECTRON_VARS = [];

function scrubElectronEnv(_env = process.env) {
  throw new Error('not implemented');
}

module.exports = { ELECTRON_VARS, scrubElectronEnv };
