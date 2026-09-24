// The SDK memo parser imports node:crypto so it can hash a charge description.
// The app calls the parser and does not hash. This stand-in lets that import
// load on device, where Node's crypto module is absent.
function createHash(algorithm) {
  return {
    update() {
      return this;
    },
    digest() {
      throw new Error(`${algorithm} is not available in the app`);
    },
  };
}

module.exports = { createHash };
