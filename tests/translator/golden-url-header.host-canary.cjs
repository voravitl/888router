// Preload that replaces every source of host identity with a canary.
//
// Used by golden-url-header.test.js to prove that the golden snapshot does
// not encode the machine that produced it. Loaded with `node --require`,
// i.e. BEFORE the application modules are imported, because
// open-sse/providers/shared.js and open-sse/config/appConstants.js capture
// os.platform() / os.arch() / os.hostname() at module load time.

const os = require("os");

const CANARY = {
  platform: "zz-canary-platform",
  arch: "zz-canary-arch",
  hostname: "zz-canary-hostname",
  version: "v99.99.99-canary",
};

os.platform = () => CANARY.platform;
os.arch = () => CANARY.arch;
os.hostname = () => CANARY.hostname;

Object.defineProperty(process, "platform", { value: CANARY.platform, configurable: true });
Object.defineProperty(process, "arch", { value: CANARY.arch, configurable: true });
Object.defineProperty(process, "version", { value: CANARY.version, configurable: true });
