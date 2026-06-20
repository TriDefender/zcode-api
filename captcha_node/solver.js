const { JSDOM, VirtualConsole } = require('jsdom');
const SCENE = process.argv[2] || '11xygtvd';
const REGION = process.argv[3] || 'sgp';
const PREFIX = process.argv[4] || 'no8xfe';

const vc = new VirtualConsole();
vc.on('error', (...a) => process.stderr.write('[jsdom] ' + a.join(' ') + '\n'));
vc.on('warn', (...a) => process.stderr.write('[jsdom warn] ' + a.join(' ') + '\n'));

const html = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function applyPolyfills(window) {
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });

  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = function (type) {
    if (/webgl/i.test(type)) {
      return {
        canvas: this,
        getParameter: () => 'Intel Inc.',
        getExtension: () => null,
        getSupportedExtensions: () => ['WEBGL_debug_renderer_info'],
        getContextAttributes: () => ({}),
        getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
      };
    }
    return {
      canvas: this,
      fillRect() {},
      clearRect() {},
      getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
      createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      setTransform() {},
      transform() {},
      drawImage() {},
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      quadraticCurveTo() {},
      closePath() {},
      clip() {},
      stroke() {},
      fill() {},
      arc() {},
      rect() {},
      ellipse() {},
      translate() {},
      scale() {},
      rotate() {},
      fillText() {},
      strokeText() {},
      measureText: (t) => ({ width: ('' + t).length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}),
      isPointInPath: () => false,
      font: '10px sans-serif',
      textBaseline: 'alphabetic',
      textAlign: 'start',
      fillStyle: '#000',
      strokeStyle: '#000',
      globalAlpha: 1,
      lineWidth: 1,
      shadowBlur: 0,
      shadowColor: '',
    };
  };
  proto.toDataURL = () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  proto.toBlob = (cb) => cb && cb(null);

  window.Worker = class {
    constructor() {}
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
    onmessage = null;
    onerror = null;
  };
  window.OffscreenCanvas =
    window.OffscreenCanvas ||
    class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return proto.getContext.call(this);
      }
    };

  try {
    Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  } catch (_) {}

  const nav = window.navigator;
  const navPatch = {
    userAgent: USER_AGENT,
    platform: 'Win32',
    language: 'en-US',
    languages: ['en-US', 'en'],
    vendor: 'Google Inc.',
    webdriver: false,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    cookieEnabled: true,
    plugins: { length: 3, item: () => null, namedItem: () => null, refresh() {} },
    mimeTypes: { length: 0, item: () => null, namedItem: () => null },
  };
  for (const [k, v] of Object.entries(navPatch)) {
    try {
      Object.defineProperty(nav, k, { value: v, configurable: true });
    } catch (_) {}
  }

  window.screen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
  };
  window.chrome = { runtime: {} };
  window.outerWidth = 1920;
  window.outerHeight = 1080;
  window.innerWidth = 1280;
  window.innerHeight = 720;
  window.devicePixelRatio = 1;
}

const dom = new JSDOM(html, {
  url: 'https://zcode.z.ai/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  userAgent: USER_AGENT,
  beforeParse(window) {
    applyPolyfills(window);
    window.AliyunCaptchaConfig = { region: REGION, prefix: PREFIX };
  },
});
const { window } = dom;

function waitFor(cond, t = 12000) {
  return new Promise((res, rej) => {
    const s = Date.now();
    const i = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch (_) {}
      if (ok) {
        clearInterval(i);
        res();
      } else if (Date.now() - s > t) {
        clearInterval(i);
        rej(new Error('timeout'));
      }
    }, 80);
  });
}

(async () => {
  await waitFor(() => typeof window.initAliyunCaptcha === 'function');
  window.initAliyunCaptcha({
    SceneId: SCENE,
    mode: 'popup',
    region: REGION,
    prefix: PREFIX,
    language: 'en',
    element: '#cap',
    button: '#btn',
    captchaLogoImg: '',
    showErrorTip: false,
    getInstance: (inst) => {
      try {
        (inst.startTracelessVerification || inst.show).call(inst);
      } catch (e) {
        console.error('start', e.message);
      }
    },
    success: (param) => {
      console.log('VERIFY_PARAM=' + param);
      process.exit(0);
    },
    fail: (err) => {
      process.stderr.write('fail=' + JSON.stringify(err) + '\n');
      process.exit(4);
    },
    onError: (err) => {
      process.stderr.write('onError=' + JSON.stringify(err) + '\n');
      process.exit(5);
    },
  });
  setTimeout(() => process.exit(2), 25000);
})().catch(() => process.exit(3));
