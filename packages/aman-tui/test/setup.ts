// Tests talk only to loopback fakes. The machine-wide proxy variables would
// route even loopback fetches through an egress proxy, so they are removed
// here, before any test file loads a client.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[name];
}
delete process.env.NODE_USE_ENV_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';
