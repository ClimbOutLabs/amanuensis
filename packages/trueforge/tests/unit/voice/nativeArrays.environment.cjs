/**
 * Jest runs tests in their own realm, so a `Float32Array` made in a test is not the one the
 * onnxruntime native binding checks for. This environment hands the real ones to the tests that
 * run the real listening model.
 */
const { TestEnvironment } = require('jest-environment-node');

class NativeArraysEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.global.Float32Array = Float32Array;
    this.global.BigInt64Array = BigInt64Array;
  }
}

module.exports = NativeArraysEnvironment;
