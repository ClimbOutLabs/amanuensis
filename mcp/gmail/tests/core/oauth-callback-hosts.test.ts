// Security #8: OAuth loopback callback URLs are restricted to loopback hosts.
//
// A non-loopback callback would deliver the authorization code to a remote
// server (open-redirector / token-theft risk), so validateLoopbackCallback
// rejects anything that is not localhost, 127.0.0.1, or ::1 — including
// IPv6 bracket normalization quirks.

import { describe, expect, it } from "vitest";
import { validateLoopbackCallback } from "../../src/core/auth-flow.js";

describe("validateLoopbackCallback (security #8)", () => {
  it.each([
    "http://localhost:3000/oauth2callback",
    "http://localhost/oauth2callback",
    "http://127.0.0.1:3000/oauth2callback",
    "http://[::1]:3000/oauth2callback",
    "http://[::1]/oauth2callback",
  ])("accepts loopback callback %s", (url) => {
    expect(() => validateLoopbackCallback(url)).not.toThrow();
  });

  it.each([
    "http://example.com/oauth2callback",
    "http://evil.localhost.evil.com/oauth2callback",
    "http://192.168.1.10:3000/oauth2callback",
    "http://10.0.0.5/oauth2callback",
    "https://localhost:3000/oauth2callback",
    "not a url",
  ])("rejects non-loopback callback %s", (url) => {
    expect(() => validateLoopbackCallback(url)).toThrow();
  });

  it("names the offending host in the rejection", () => {
    expect(() => validateLoopbackCallback("http://example.com/cb")).toThrow(
      /example\.com/,
    );
  });

  it("rejects lookalike hosts that merely contain 'localhost'", () => {
    expect(() => validateLoopbackCallback("http://localhost.evil.com/cb")).toThrow(
      /loopback host/,
    );
  });
});
